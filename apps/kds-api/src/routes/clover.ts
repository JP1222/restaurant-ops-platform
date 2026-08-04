import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { KdsTicketStatus } from "@rop/db-kds";
import { OrderProvider, ProviderEventStatus, type Prisma } from "@rop/db-kds";
import { CLOVER_ADMIN_PATH, normalizeReturnToPath } from "../lib/clover-admin.js";
import {
  canBootstrapCloverMerchantFromEnv,
  getConfiguredCloverMerchantId,
  resolveDefaultCloverMerchantId
} from "../lib/clover-runtime.js";
import { buildCloverWebhookFingerprint, parseCloverWebhookEvents } from "../lib/clover-webhooks.js";
import { makeOauthState, readOauthState } from "../lib/crypto.js";
import { upsertCloverProviderState } from "../lib/provider-app-state.js";
import { createProviderEvents, enqueueProviderEvents } from "../lib/provider-ingress.js";
import type { AppServices } from "../lib/services.js";
import { kdsCloverWebhookDedupedTotal, kdsProviderEnqueueFailuresTotal, kdsWebhookAckSeconds } from "../lib/metrics.js";
import { serializeOverview } from "../lib/ticket-serializer.js";

type QueryShape = {
  merchantId?: string;
  merchant_id?: string;
  returnTo?: string;
  code?: string;
  auth_code?: string;
  state?: string;
};

function merchantIdFromRequest(query: QueryShape, fallback?: string) {
  return query.merchantId ?? fallback;
}

function buildAdminRedirectUrl(
  appBaseUrl: string,
  returnTo: string,
  params: Record<string, string | null | undefined>
) {
  const url = new URL(normalizeReturnToPath(returnTo), appBaseUrl);

  for (const [key, value] of Object.entries(params)) {
    if (value) {
      url.searchParams.set(key, value);
    }
  }

  return url.toString();
}

export async function registerCloverRoutes(app: FastifyInstance, services: AppServices) {
  // Operator awareness: in production the webhook fails closed when no auth code
  // is configured (GH #454). Warn loudly at boot so a misconfig is visible before
  // Clover deliveries start getting 401s, rather than silently dropping orders.
  if (services.config.nodeEnv === "production" && !services.config.cloverWebhookAuthCode) {
    app.log.warn(
      "CLOVER_WEBHOOK_AUTH_CODE is unset in production — Clover webhooks will be rejected (401) until it is configured."
    );
  }

  app.get<{ Querystring: QueryShape }>("/api/clover/install", async (request, reply) => {
    const merchantId = merchantIdFromRequest(request.query, getConfiguredCloverMerchantId(services.config));
    const returnTo = normalizeReturnToPath(
      typeof request.query.returnTo === "string" ? request.query.returnTo : CLOVER_ADMIN_PATH
    );
    const state = makeOauthState(services.config.sessionSecret, {
      merchantId: merchantId ?? "",
      returnTo
    });

    reply.redirect(services.clover.buildAuthorizeUrl(state, merchantId));
  });

  app.get<{ Querystring: QueryShape }>("/api/clover/oauth/callback", async (request, reply) => {
    const code = typeof request.query.code === "string" ? request.query.code : typeof request.query.auth_code === "string" ? request.query.auth_code : null;
    const fallbackMerchantId =
      (typeof request.query.merchantId === "string" ? request.query.merchantId : null) ??
      (typeof request.query.merchant_id === "string" ? request.query.merchant_id : null);
    let state: ReturnType<typeof readOauthState> | null;

    try {
      state = readOauthState(services.config.sessionSecret, typeof request.query.state === "string" ? request.query.state : undefined);
    } catch {
      reply.redirect(
        buildAdminRedirectUrl(services.config.appBaseUrl, CLOVER_ADMIN_PATH, {
          merchantId: fallbackMerchantId,
          oauthError: "invalid_state"
        })
      );
      return;
    }

    const merchantId =
      fallbackMerchantId ??
      state.merchantId;
    const returnTo = normalizeReturnToPath(state.returnTo);

    if (!merchantId) {
      reply.redirect(
        buildAdminRedirectUrl(services.config.appBaseUrl, returnTo, {
          oauthError: "missing_merchant_id"
        })
      );
      return;
    }

    if (!code) {
      reply.redirect(
        buildAdminRedirectUrl(services.config.appBaseUrl, returnTo, {
          merchantId,
          oauthError: "missing_authorization_code"
        })
      );
      return;
    }

    try {
      await services.clover.exchangeAuthorizationCode(code, merchantId);
    } catch {
      reply.redirect(
        buildAdminRedirectUrl(services.config.appBaseUrl, returnTo, {
          merchantId,
          oauthError: "token_exchange_failed"
        })
      );
      return;
    }

    reply.redirect(
      buildAdminRedirectUrl(services.config.appBaseUrl, returnTo, {
        merchantId,
        connected: "1"
      })
    );
  });

  const handleCloverWebhook = async (
    request: FastifyRequest<{ Body: Record<string, unknown> }>,
    reply: FastifyReply
  ) => {
    const startedAt = Date.now();
    const payload = (request.body ?? {}) as Record<string, unknown>;
    const verificationCode = typeof payload.verificationCode === "string" ? payload.verificationCode.trim() : "";
    if (verificationCode) {
      await upsertCloverProviderState(services.prisma, services.config, {
        latestWebhookVerificationCode: verificationCode,
        latestWebhookVerificationAt: new Date()
      });

      return {
        ok: true,
        verificationCodeReceived: true
      };
    }

    const authCodeHeader = request.headers["x-clover-auth"] ?? request.headers["x-clover-auth-code"];
    const authCode = Array.isArray(authCodeHeader) ? authCodeHeader[0] : authCodeHeader;
    const expectedAuthCode = services.config.cloverWebhookAuthCode;
    if (!expectedAuthCode) {
      // Fail closed in production: a missing CLOVER_WEBHOOK_AUTH_CODE must NOT be
      // read as "accept anonymous webhooks" — that let unauthenticated POSTs
      // enqueue Clover sync jobs for any merchant (GH #454). Dev/sandbox stay
      // permissive when unset so local testing needs no secret. The verification
      // handshake above is already returned before this gate.
      if (services.config.nodeEnv === "production") {
        reply.code(401);
        return { error: "Clover webhook auth code is not configured." };
      }
    } else if (authCode !== expectedAuthCode) {
      reply.code(401);
      return { error: "Invalid Clover webhook auth code." };
    }

    const events = parseCloverWebhookEvents(payload);
    if (events.length === 0) {
      return { ok: true, ignored: true };
    }

    let enqueued: number;
    let ignored = 0;
    const merchantIds = new Set<string>();
    const normalized = events.flatMap((event) => {
      const merchantId = event.merchantId || getConfiguredCloverMerchantId(services.config);
      if (!merchantId || !event.orderId) {
        ignored += 1;
        return [];
      }
      merchantIds.add(merchantId);
      return [{ ...event, merchantId, orderId: event.orderId }];
    });

    if (canBootstrapCloverMerchantFromEnv(services.config)) {
      await services.clover.bootstrapMerchantFromEnv();
    }
    const merchants = await services.prisma.cloverMerchant.findMany({
      where: {
        id: {
          in: [...merchantIds]
        }
      },
      select: { id: true }
    });
    const knownMerchantIds = new Set(merchants.map((merchant) => merchant.id));
    const accepted = normalized.filter((event) => {
      const known = knownMerchantIds.has(event.merchantId);
      if (!known) {
        ignored += 1;
      }
      return known;
    });

    const webhookRows = accepted.map((event) => ({
      merchantId: event.merchantId,
      eventId: event.eventId,
      fingerprint: buildCloverWebhookFingerprint(event),
      topic: event.topic,
      orderId: event.orderId,
      modifiedTime: event.modifiedTime ? new Date(event.modifiedTime) : null,
      raw: event.payload as Prisma.InputJsonValue
    }));
    if (webhookRows.length > 0) {
      // L1 dedup (GH #129): the unique index is (merchantId, eventId), so
      // skipDuplicates collapses Clover's at-least-once re-deliveries. The
      // returned count is rows actually inserted; the shortfall is duplicates
      // we dropped — surfaced as a log + metric so operators see resend volume.
      const inserted = await services.prisma.cloverWebhookEvent.createMany({
        data: webhookRows,
        skipDuplicates: true
      });
      const dedupedWebhooks = webhookRows.length - inserted.count;
      if (dedupedWebhooks > 0) {
        kdsCloverWebhookDedupedTotal.inc({ provider: "clover" }, dedupedWebhooks);
        request.log.info(
          { provider: "clover", deduped: dedupedWebhooks, received: webhookRows.length },
          "Dropped duplicate Clover webhook deliveries by eventId."
        );
      }
    }

    const providerEvents = await createProviderEvents(
      services,
      accepted.map((event) => ({
        provider: OrderProvider.CLOVER,
        merchantId: event.merchantId,
        sourceOrderId: event.orderId,
        fingerprint: buildCloverWebhookFingerprint(event),
        topic: event.topic,
        raw: event.payload as Prisma.InputJsonValue,
        receivedAt: new Date(startedAt)
      }))
    );
    const deduped = Math.max(
      0,
      accepted.length - providerEvents.filter((event) => event.status === ProviderEventStatus.RECEIVED && !event.queuedAt).length
    );

    try {
      enqueued = await enqueueProviderEvents(services, providerEvents);
    } catch (cause) {
      kdsProviderEnqueueFailuresTotal.inc({ provider: "clover" });
      request.log.error({ err: cause }, "Failed to enqueue Clover provider events.");
      // Fail the ack so Clover redelivers (at-least-once). A 200 here is read as
      // "accepted" and the event is never resent — silently dropped (GH #460).
      reply.code(503);
      return { ok: false, error: "enqueue_failed" };
    }

    await services.prisma.cloverMerchant.updateMany({
      where: { id: { in: [...knownMerchantIds] } },
      data: {
        lastWebhookAt: new Date(),
        webhookStatus: "healthy"
      }
    });
    await upsertCloverProviderState(services.prisma, services.config, {
      lastSignedWebhookAt: new Date()
    });

    kdsWebhookAckSeconds.observe({ provider: "clover" }, (Date.now() - startedAt) / 1000);
    return {
      ok: true,
      enqueued,
      deduped,
      ignored
    };
  };

  app.post<{ Body: Record<string, unknown> }>("/api/clover/webhooks", handleCloverWebhook);
  app.post<{ Body: Record<string, unknown> }>("/webhooks/clover", handleCloverWebhook);

  app.get<{ Querystring: QueryShape }>("/api/clover/status", async (request) => {
    const merchantId = await resolveDefaultCloverMerchantId(
      services.prisma,
      services.config,
      typeof request.query.merchantId === "string" ? request.query.merchantId : undefined
    );
    if (!merchantId) {
      return serializeOverview(null, {
        NEW: 0,
        ON_HOLD: 0,
        ACKNOWLEDGED: 0,
        IN_PROGRESS: 0,
        READY: 0,
        COMPLETED: 0
      }, 0);
    }

    const [merchant, deadLetterCount, grouped] = await Promise.all([
      services.prisma.cloverMerchant.findUnique({ where: { id: merchantId } }),
      services.prisma.deadLetterJob.count({ where: { merchantId, resolvedAt: null } }),
      services.prisma.kdsTicket.groupBy({
        by: ["status"],
        _count: { _all: true },
        where: { merchantId }
      })
    ]);

    const counts: Record<KdsTicketStatus, number> = {
      NEW: 0,
      ON_HOLD: 0,
      ACKNOWLEDGED: 0,
      IN_PROGRESS: 0,
      READY: 0,
      COMPLETED: 0
    };

    for (const row of grouped) {
      counts[row.status] = row._count._all;
    }

    return serializeOverview(merchant, counts, deadLetterCount);
  });
}
