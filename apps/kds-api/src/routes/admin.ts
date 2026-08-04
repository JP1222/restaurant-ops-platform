import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import {
  CLOVER_ADMIN_PATH,
  getCloverDashboardConfig,
  getCloverEnvReadiness
} from "../lib/clover-admin.js";
import {
  getConfiguredCloverMerchantId,
  isLegacyCloverTokenRecord,
  isOauthConnectedCloverMerchant
} from "../lib/clover-runtime.js";
import { cloverProviderStateWhere } from "../lib/provider-app-state.js";
import type { AppServices } from "../lib/services.js";
import { buildAdminSystemStatus } from "../lib/system-status.js";
import { WEB_SESSION_COOKIE_NAME } from "../lib/web-auth.js";
import { createDeviceToken } from "../lib/kds-auth.js";
import { createPairingClaim, resolveTenantIdForMerchant } from "../lib/device-pairing.js";
import { createAdminBearerGuard } from "../lib/admin-bearer-auth.js";
import { loadBoardSettings, saveBoardSettings } from "../lib/board-settings-service.js";
import {
  AdminUserCreateRequestSchema,
  AdminUserUpdateRequestSchema,
  DeliverectIntegrationUpdateRequestSchema,
  KdsDeviceCreateRequestSchema,
  KdsDevicePairCreateRequestSchema,
  KitchenBoardSettingsSchema,
  PasswordSetRequestSchema
} from "@rop/contracts";
import { clearMerchantOrderData } from "../jobs/nightly-reset.js";
import {
  resolveDeliverectApiToken,
  resolveDeliverectHmacSecret,
  resolveNightlyResetSettings
} from "../lib/board-settings.js";
import { encryptSecret, toBytes } from "../lib/crypto/encryption.js";
import { OrderProvider, type IntegrationEnvironment, type KdsProviderConfig } from "@rop/db-kds";
import { listPasskeys, PASSWORD_SETUP_TTL_SECONDS } from "@rop/auth/server";
import {
  assertAdminUserExists,
  createAdminUser,
  deleteAdminUser,
  listAdminUsers,
  revokeAdminUserPasskey,
  updateAdminUser,
  UserAdminError
} from "../lib/admin-user-service.js";

function firstHeaderValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeRequestOrigin(request: Pick<FastifyRequest, "headers">, appBaseUrl: string) {
  const expected = new URL(appBaseUrl).origin;
  const originHeader = firstHeaderValue(request.headers.origin);
  if (originHeader) {
    return {
      matches: originHeader === expected,
      expected
    };
  }

  const refererHeader = firstHeaderValue(request.headers.referer);
  if (refererHeader) {
    try {
      return {
        matches: new URL(refererHeader).origin === expected,
        expected
      };
    } catch {
      return {
        matches: false,
        expected
      };
    }
  }

  return {
    matches: false,
    expected
  };
}


export async function registerAdminRoutes(app: FastifyInstance, services: AppServices) {
  const requireSession = async (request: FastifyRequest, reply: FastifyReply) => {
    const sessionId = request.cookies[WEB_SESSION_COOKIE_NAME];
    if (!sessionId) {
      reply.redirect(`/login?returnTo=${encodeURIComponent(request.raw.url ?? CLOVER_ADMIN_PATH)}`, 302);
      return reply;
    }

    const session = await services.auth.readSession(sessionId);
    if (!session) {
      reply.redirect(`/login?returnTo=${encodeURIComponent(request.raw.url ?? CLOVER_ADMIN_PATH)}`, 302);
      return reply;
    }

    const account = await services.auth.getAccountById(session.accountId);
    if (!account) {
      await services.auth.destroySession(sessionId);
      reply.clearCookie(WEB_SESSION_COOKIE_NAME, services.auth.getSessionCookieOptions());
      reply.redirect(`/login?returnTo=${encodeURIComponent(request.raw.url ?? CLOVER_ADMIN_PATH)}`, 302);
      return reply;
    }

    reply.setCookie(WEB_SESSION_COOKIE_NAME, sessionId, services.auth.getSessionCookieOptions());
  };

  // Phase 4.5 closeout: the in-kds-api admin HTML is retired. Operators land
  // in Backoffice instead. /admin and /admin/integrations/clover both
  // permanent-redirect there.
  app.get("/admin", async (_request, reply) => {
    reply.redirect(`${services.config.backofficeBaseUrl}/admin/devices`, 301);
  });

  app.get(CLOVER_ADMIN_PATH, async (_request, reply) => {
    reply.redirect(`${services.config.backofficeBaseUrl}/admin/integrations`, 301);
  });

  app.get<{ Querystring: { merchantId?: string } }>("/api/admin/system-status", { preHandler: requireSession }, async (request) => {
    const requestedMerchantId = typeof request.query.merchantId === "string" ? request.query.merchantId : undefined;
    const providerState = await services.prisma.providerAppState.findUnique({
      where: cloverProviderStateWhere(services.config)
    });
    const preferredMerchantId =
      requestedMerchantId ??
      providerState?.tokenModeMerchantId ??
      getConfiguredCloverMerchantId(services.config) ??
      undefined;
    const merchant = preferredMerchantId
      ? await services.prisma.cloverMerchant.findUnique({ where: { id: preferredMerchantId } })
      : await services.prisma.cloverMerchant.findFirst({ orderBy: { updatedAt: "desc" } });

    return buildAdminSystemStatus(services, merchant);
  });

  app.get<{ Querystring: { merchantId?: string } }>("/api/kds/devices", { preHandler: requireSession }, async (request, reply) => {
    const merchantId = typeof request.query.merchantId === "string" ? request.query.merchantId : undefined;
    if (!merchantId) {
      reply.code(400);
      return { error: "merchantId is required." };
    }

    const devices = await services.prisma.kdsDeviceToken.findMany({
      where: { merchantId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        merchantId: true,
        label: true,
        role: true,
        createdAt: true,
        lastUsedAt: true,
        revokedAt: true
      }
    });

    return { devices };
  });

  app.post<{ Body: z.infer<typeof KdsDeviceCreateRequestSchema> }>("/api/kds/devices", { preHandler: requireSession }, async (request, reply) => {
    const origin = normalizeRequestOrigin(request, services.config.appBaseUrl);
    if (!origin.matches) {
      reply.code(403);
      return {
        error: "Untrusted origin.",
        expectedOrigin: origin.expected
      };
    }

    const parsed = KdsDeviceCreateRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "merchantId and label are required." };
    }

    const tenantId = await resolveTenantIdForMerchant(services.prisma, parsed.data.merchantId);
    const generated = createDeviceToken();
    const device = await services.prisma.kdsDeviceToken.create({
      data: {
        merchantId: parsed.data.merchantId,
        label: parsed.data.label,
        role: "KDS",
        tenantId,
        tokenHash: generated.tokenHash
      },
      select: {
        id: true,
        merchantId: true,
        label: true,
        role: true,
        createdAt: true
      }
    });

    return {
      ...device,
      token: generated.token
    };
  });

  app.delete<{ Params: { deviceId: string } }>("/api/kds/devices/:deviceId", { preHandler: requireSession }, async (request, reply) => {
    const origin = normalizeRequestOrigin(request, services.config.appBaseUrl);
    if (!origin.matches) {
      reply.code(403);
      return {
        error: "Untrusted origin.",
        expectedOrigin: origin.expected
      };
    }

    await services.prisma.kdsDeviceToken.update({
      where: { id: request.params.deviceId },
      data: { revokedAt: new Date() }
    });

    return { ok: true };
  });

  // -- Internal admin surface --------------------------------------------------
  // /api/admin/kds/* endpoints are intended for cross-service callers (Backoffice,
  // future automation). They authenticate via KDS_INTERNAL_ADMIN_TOKEN bearer
  // instead of session cookie, so that the caller is not required to be a browser
  // with a kds-web session. The existing /api/kds/devices* session-gated routes
  // remain in place for the legacy in-kds-web admin UI; Phase 4 closeout deletes
  // them along with the HTML /admin route.
  const adminBearer = createAdminBearerGuard(services.config.kdsInternalAdminToken);

  async function resolveAdminMerchantId(requested: string | undefined) {
    if (requested && requested.trim().length > 0) {
      return requested.trim();
    }
    const providerState = await services.prisma.providerAppState.findUnique({
      where: cloverProviderStateWhere(services.config)
    });
    const fromState = providerState?.tokenModeMerchantId;
    if (fromState) {
      return fromState;
    }
    const fromConfig = getConfiguredCloverMerchantId(services.config);
    if (fromConfig) {
      return fromConfig;
    }
    const newest = await services.prisma.cloverMerchant.findFirst({ orderBy: { updatedAt: "desc" } });
    return newest?.id;
  }

  app.get<{ Querystring: { merchantId?: string } }>(
    "/api/admin/kds/devices",
    { preHandler: adminBearer },
    async (request, reply) => {
      const merchantId = await resolveAdminMerchantId(request.query.merchantId);
      if (!merchantId) {
        reply.code(400);
        return { error: "merchantId could not be resolved." };
      }

      const devices = await services.prisma.kdsDeviceToken.findMany({
        where: { merchantId },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          merchantId: true,
          label: true,
          role: true,
          createdAt: true,
          lastUsedAt: true,
          revokedAt: true
        }
      });

      return { merchantId, devices };
    }
  );

  app.post<{ Body: z.infer<typeof KdsDeviceCreateRequestSchema> }>(
    "/api/admin/kds/devices",
    { preHandler: adminBearer },
    async (request, reply) => {
      const parsed = KdsDeviceCreateRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "merchantId and label are required." };
      }

      const tenantId = await resolveTenantIdForMerchant(services.prisma, parsed.data.merchantId);
      const generated = createDeviceToken();
      const device = await services.prisma.kdsDeviceToken.create({
        data: {
          merchantId: parsed.data.merchantId,
          label: parsed.data.label,
          role: "KDS",
          tenantId,
          tokenHash: generated.tokenHash
        },
        select: {
          id: true,
          merchantId: true,
          label: true,
          role: true,
          createdAt: true
        }
      });

      return {
        ...device,
        token: generated.token
      };
    }
  );

  // Device pairing (ADR-0818 Phase-2b): generate a one-time pairing claim for a
  // store. Returns a short-lived claim code + pairUrl (NOT the durable token —
  // the device redeems the code at the public /api/pair/redeem). Mirrors the
  // create route above; adds a `role` (KDS board vs DISPLAY order-ready screen).
  app.post<{ Body: z.infer<typeof KdsDevicePairCreateRequestSchema> }>(
    "/api/admin/kds/devices/pair",
    { preHandler: adminBearer },
    async (request, reply) => {
      const parsed = KdsDevicePairCreateRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "merchantId and label are required." };
      }
      return createPairingClaim(services, parsed.data);
    }
  );

  app.delete<{ Params: { deviceId: string } }>(
    "/api/admin/kds/devices/:deviceId",
    { preHandler: adminBearer },
    async (request) => {
      await services.prisma.kdsDeviceToken.update({
        where: { id: request.params.deviceId },
        data: { revokedAt: new Date() }
      });
      return { ok: true };
    }
  );

  app.get<{ Querystring: { merchantId?: string } }>(
    "/api/admin/kds/board-settings",
    { preHandler: adminBearer },
    async (request, reply) => {
      const merchantId = await resolveAdminMerchantId(request.query.merchantId);
      if (!merchantId) {
        reply.code(400);
        return { error: "merchantId could not be resolved." };
      }
      return { merchantId, settings: await loadBoardSettings(services, merchantId) };
    }
  );

  app.put<{ Querystring: { merchantId?: string } }>(
    "/api/admin/kds/board-settings",
    { preHandler: adminBearer },
    async (request, reply) => {
      const merchantId = await resolveAdminMerchantId(request.query.merchantId);
      if (!merchantId) {
        reply.code(400);
        return { error: "merchantId could not be resolved." };
      }

      const parsed = KitchenBoardSettingsSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400);
        return {
          error: "invalid_board_settings",
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message
          }))
        };
      }

      return {
        merchantId,
        // Admin-bearer tier: accepts all fields including operator-config
        // and Deliverect secrets (Phase 4.5.4 Iron Law #4 gating).
        settings: await saveBoardSettings(services, merchantId, parsed.data, "admin")
      };
    }
  );

  // -- Admin users + passkeys (Phase 4.2) -------------------------------------

  function userErrorReply(reply: FastifyReply, error: unknown) {
    if (error instanceof UserAdminError) {
      const status =
        error.code === "username_taken"
          ? 409
          : error.code === "user_not_found" || error.code === "passkey_not_found"
            ? 404
            : // last_admin / last_login_method / last_owner — invariant guards
              422;
      reply.code(status);
      return { error: error.code };
    }
    throw error;
  }

  function buildSetupUrl(token: string) {
    return `${services.config.backofficeBaseUrl}/set-password?token=${encodeURIComponent(token)}`;
  }

  app.get("/api/admin/kds/users", { preHandler: adminBearer }, async () => {
    const users = await listAdminUsers(services.prismaAuth);
    return { users };
  });

  app.post<{ Body: z.infer<typeof AdminUserCreateRequestSchema> }>(
    "/api/admin/kds/users",
    { preHandler: adminBearer },
    async (request, reply) => {
      const parsed = AdminUserCreateRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400);
        return {
          error: "invalid_body",
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message
          }))
        };
      }
      try {
        const user = await createAdminUser(services.prismaAuth, parsed.data);
        const token = await services.auth.createPasswordSetupToken(user.id, "invite");
        return { user, setupUrl: buildSetupUrl(token), expiresInSeconds: PASSWORD_SETUP_TTL_SECONDS };
      } catch (error) {
        return userErrorReply(reply, error);
      }
    }
  );

  app.patch<{ Params: { userId: string }; Body: z.infer<typeof AdminUserUpdateRequestSchema> }>(
    "/api/admin/kds/users/:userId",
    { preHandler: adminBearer },
    async (request, reply) => {
      const parsed = AdminUserUpdateRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid_body" };
      }
      try {
        return { user: await updateAdminUser(services.prismaAuth, request.params.userId, parsed.data) };
      } catch (error) {
        return userErrorReply(reply, error);
      }
    }
  );

  app.delete<{ Params: { userId: string } }>(
    "/api/admin/kds/users/:userId",
    { preHandler: adminBearer },
    async (request, reply) => {
      try {
        await deleteAdminUser(services.prismaAuth, request.params.userId);
        return { ok: true };
      } catch (error) {
        return userErrorReply(reply, error);
      }
    }
  );

  app.post<{ Params: { userId: string } }>(
    "/api/admin/kds/users/:userId/password",
    { preHandler: adminBearer },
    async (request, reply) => {
      try {
        await assertAdminUserExists(services.prismaAuth, request.params.userId);
        const token = await services.auth.createPasswordSetupToken(request.params.userId, "reset");
        return { ok: true, setupUrl: buildSetupUrl(token), expiresInSeconds: PASSWORD_SETUP_TTL_SECONDS };
      } catch (error) {
        return userErrorReply(reply, error);
      }
    }
  );

  // Token-gated set-password redemption (ADR-0029 P2). The one-time setup token
  // in the body is the user's credential; adminBearer ensures only the
  // Backoffice BFF (which holds the internal token) can reach this endpoint —
  // the public /set-password page proxies through it. Returns a 200
  // discriminated result so the page maps { reason } to inline UI.
  app.post<{ Body: z.infer<typeof PasswordSetRequestSchema> }>(
    "/api/admin/kds/password/set",
    { preHandler: adminBearer },
    async (request, reply) => {
      const parsed = PasswordSetRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid_body" };
      }
      return services.auth.setPasswordWithToken(parsed.data);
    }
  );

  app.get<{ Params: { userId: string } }>(
    "/api/admin/kds/users/:userId/passkeys",
    { preHandler: adminBearer },
    async (request, reply) => {
      const user = await services.prismaAuth.webAdminAccount.findUnique({
        where: { id: request.params.userId },
        select: { id: true }
      });
      if (!user) {
        reply.code(404);
        return { error: "user_not_found" };
      }
      const passkeys = await listPasskeys(services.prismaAuth, request.params.userId);
      return { passkeys };
    }
  );

  app.delete<{ Params: { userId: string; credentialId: string } }>(
    "/api/admin/kds/users/:userId/passkeys/:credentialId",
    { preHandler: adminBearer },
    async (request, reply) => {
      try {
        await revokeAdminUserPasskey(
          services.prismaAuth,
          request.params.userId,
          request.params.credentialId
        );
        return { ok: true };
      } catch (error) {
        return userErrorReply(reply, error);
      }
    }
  );

  // -- Integrations / Deliverect (Phase 4.5) ----------------------------------
  //
  // The Backoffice BFF sends plaintext token + secret on the bearer-guarded
  // internal hop. kds-api is the storage boundary: it encrypts via
  // lib/crypto/encryption.ts and persists into the apiTokenCipher /
  // hmacSecretCipher BYTEA columns. The legacy plaintext columns are nulled
  // on the same write so a future Phase 4.5.7 migration can drop them
  // without orphaning ciphered rows.

  function maskToken(token: string | null): string | null {
    if (!token) return null;
    const tail = token.slice(-4);
    return `••••${tail}`;
  }

  function maskSecret(value: string | null): string | null {
    if (!value) return null;
    return "••••";
  }

  function serializeDeliverectIntegration(
    row: Pick<
      KdsProviderConfig,
      | "enabled"
      | "environment"
      | "externalLocationId"
      | "providerLocationId"
      | "channelLinkId"
      | "apiToken"
      | "hmacSecret"
      | "apiTokenCipher"
      | "hmacSecretCipher"
      | "registerWebhookStatus"
      | "ordersWebhookStatus"
      | "lastRegisterWebhookAt"
      | "lastOrderWebhookAt"
    >
  ) {
    const apiToken = resolveDeliverectApiToken(row);
    const hmacSecret = resolveDeliverectHmacSecret(row);
    return {
      enabled: row.enabled,
      environment:
        row.environment === "PRODUCTION" ? ("production" as const) : ("staging" as const),
      externalLocationId: row.externalLocationId ?? "",
      providerLocationId: row.providerLocationId ?? "",
      channelLinkId: row.channelLinkId ?? "",
      apiTokenMask: maskToken(apiToken),
      hmacSecretMask: maskSecret(hmacSecret),
      registerWebhookStatus: row.registerWebhookStatus,
      ordersWebhookStatus: row.ordersWebhookStatus,
      lastRegisterWebhookAt: row.lastRegisterWebhookAt
        ? row.lastRegisterWebhookAt.toISOString()
        : null,
      lastOrderWebhookAt: row.lastOrderWebhookAt
        ? row.lastOrderWebhookAt.toISOString()
        : null
    };
  }

  app.get<{ Querystring: { merchantId?: string } }>(
    "/api/admin/kds/integrations/deliverect",
    { preHandler: adminBearer },
    async (request, reply) => {
      const merchantId = await resolveAdminMerchantId(request.query.merchantId);
      if (!merchantId) {
        reply.code(400);
        return { error: "merchantId could not be resolved." };
      }

      const provider = await services.prisma.kdsProviderConfig.findUnique({
        where: {
          merchantId_provider: {
            merchantId,
            provider: OrderProvider.DELIVERECT
          }
        }
      });

      if (!provider) {
        reply.code(404);
        return { error: "not_configured" };
      }

      return { merchantId, config: serializeDeliverectIntegration(provider) };
    }
  );

  app.put<{ Querystring: { merchantId?: string }; Body: z.infer<typeof DeliverectIntegrationUpdateRequestSchema> }>(
    "/api/admin/kds/integrations/deliverect",
    { preHandler: adminBearer },
    async (request, reply) => {
      const merchantId = await resolveAdminMerchantId(request.query.merchantId);
      if (!merchantId) {
        reply.code(400);
        return { error: "merchantId could not be resolved." };
      }

      const parsed = DeliverectIntegrationUpdateRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400);
        return {
          error: "invalid_body",
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message
          }))
        };
      }

      const body = parsed.data;
      const envDb: IntegrationEnvironment =
        body.environment === "production" ? "PRODUCTION" : "STAGING";
      const base = {
        enabled: body.enabled,
        environment: envDb,
        externalLocationId: body.externalLocationId || null,
        providerLocationId: body.providerLocationId || null,
        channelLinkId: body.channelLinkId || null
      };

      const tokenCipher = body.apiToken
        ? { apiTokenCipher: toBytes(encryptSecret(body.apiToken)), apiToken: null }
        : {};
      const hmacCipher = body.hmacSecret
        ? { hmacSecretCipher: toBytes(encryptSecret(body.hmacSecret)), hmacSecret: null }
        : {};

      const saved = await services.prisma.kdsProviderConfig.upsert({
        where: {
          merchantId_provider: {
            merchantId,
            provider: OrderProvider.DELIVERECT
          }
        },
        update: { ...base, ...tokenCipher, ...hmacCipher },
        create: {
          merchantId,
          provider: OrderProvider.DELIVERECT,
          ...base,
          ...tokenCipher,
          ...hmacCipher
        }
      });

      return { merchantId, config: serializeDeliverectIntegration(saved) };
    }
  );

  app.delete<{ Querystring: { merchantId?: string } }>(
    "/api/admin/kds/integrations/deliverect",
    { preHandler: adminBearer },
    async (request, reply) => {
      const merchantId = await resolveAdminMerchantId(request.query.merchantId);
      if (!merchantId) {
        reply.code(400);
        return { error: "merchantId could not be resolved." };
      }

      const existing = await services.prisma.kdsProviderConfig.findUnique({
        where: {
          merchantId_provider: {
            merchantId,
            provider: OrderProvider.DELIVERECT
          }
        },
        select: { id: true }
      });

      if (!existing) {
        reply.code(404);
        return { error: "not_configured" };
      }

      await services.prisma.kdsProviderConfig.update({
        where: { id: existing.id },
        data: {
          enabled: false,
          apiToken: null,
          hmacSecret: null,
          apiTokenCipher: null,
          hmacSecretCipher: null
        }
      });

      reply.code(204);
      return reply.send();
    }
  );

  // -- Integrations / Clover (Phase 4.3) --------------------------------------

  app.get(
    "/api/admin/kds/integrations/clover",
    { preHandler: adminBearer },
    async () => {
      const providerState = await services.prisma.providerAppState.findUnique({
        where: cloverProviderStateWhere(services.config)
      });
      const preferredMerchantId =
        providerState?.tokenModeMerchantId ?? getConfiguredCloverMerchantId(services.config);
      const merchant = preferredMerchantId
        ? await services.prisma.cloverMerchant.findUnique({ where: { id: preferredMerchantId } })
        : await services.prisma.cloverMerchant.findFirst({ orderBy: { updatedAt: "desc" } });

      const status = await buildAdminSystemStatus(services, merchant);
      const dashboard = getCloverDashboardConfig(services.config);
      const readiness = {
        env: getCloverEnvReadiness(services.config)
      };

      return {
        merchant: merchant
          ? {
              id: merchant.id,
              authStatus: merchant.authStatus,
              webhookStatus: merchant.webhookStatus ?? null,
              region: merchant.region ?? null,
              lastWebhookAt: merchant.lastWebhookAt ? merchant.lastWebhookAt.toISOString() : null,
              lastSyncAt: merchant.lastSyncAt ? merchant.lastSyncAt.toISOString() : null,
              lastReconciledAt: merchant.lastReconciledAt
                ? merchant.lastReconciledAt.toISOString()
                : null,
              updatedAt: merchant.updatedAt.toISOString(),
              isOauthConnected: isOauthConnectedCloverMerchant(merchant),
              isLegacyTokenRecord: isLegacyCloverTokenRecord(merchant)
            }
          : null,
        configuredMerchantId: getConfiguredCloverMerchantId(services.config),
        status: status.sync,
        dashboard,
        readiness
      };
    }
  );

  // -- Daily Reset (Phase 4.4) ------------------------------------------------

  app.get<{ Querystring: { merchantId?: string } }>(
    "/api/admin/kds/daily-reset",
    { preHandler: adminBearer },
    async (request, reply) => {
      const merchantId = await resolveAdminMerchantId(request.query.merchantId);
      if (!merchantId) {
        reply.code(400);
        return { error: "merchantId could not be resolved." };
      }

      const merchant = await services.prisma.cloverMerchant.findUnique({
        where: { id: merchantId },
        select: { resetCutoffAt: true }
      });

      const filter = await services.prisma.kdsFilter.findUnique({
        where: { merchantId },
        select: { boardSettings: true }
      });

      const settings = resolveNightlyResetSettings(filter, services.config);

      return {
        merchantId,
        schedule: {
          enabled: settings.enabled,
          timeZone: settings.timeZone,
          hour: settings.hour,
          minute: settings.minute
        },
        lastResetAt: merchant?.resetCutoffAt ? merchant.resetCutoffAt.toISOString() : null
      };
    }
  );

  app.post<{ Body: { merchantId?: string } }>(
    "/api/admin/kds/daily-reset",
    { preHandler: adminBearer },
    async (request, reply) => {
      const requested = typeof request.body?.merchantId === "string" ? request.body.merchantId : undefined;
      const merchantId = await resolveAdminMerchantId(requested);
      if (!merchantId) {
        reply.code(400);
        return { error: "merchantId could not be resolved." };
      }

      const merchant = await services.prisma.cloverMerchant.findUnique({
        where: { id: merchantId },
        select: { id: true }
      });
      if (!merchant) {
        reply.code(404);
        return { error: "merchant_not_found" };
      }

      const resetAt = new Date();
      await clearMerchantOrderData(services, merchantId, resetAt);
      return { ok: true, merchantId, resetAt: resetAt.toISOString() };
    }
  );

}
