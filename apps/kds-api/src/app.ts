import * as Sentry from "@sentry/node";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { loadConfig } from "./config.js";
import { canBootstrapCloverMerchantFromEnv } from "./lib/clover-runtime.js";
import { validateCloverTokenAtStartup } from "./lib/clover-startup-validation.js";
import { cloverProviderStateWhere, upsertCloverProviderState } from "./lib/provider-app-state.js";
import { DEFAULT_TENANT_ID } from "@rop/contracts";
import { createServices, type AppServices } from "./lib/services.js";
import { provisionTenant } from "./lib/provision-tenant.js";
import { bootstrapSquareAccountFromEnv, canBootstrapSquareAccountFromEnv } from "./lib/square-account.js";
import { SquareConnectError } from "./lib/square-client.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerCloverRoutes } from "./routes/clover.js";
import { registerDeliverectRoutes } from "./routes/deliverect.js";
import { registerDlqRoutes } from "./routes/dlq.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerInternalRoutes } from "./routes/internal.js";
import { registerKdsRoutes } from "./routes/kds.js";
import { registerMetricsRoutes } from "./routes/metrics.js";
import { registerOrderRoutes } from "./routes/order.js";
import { registerPairingRoutes } from "./routes/pairing.js";
import { registerSquareRoutes } from "./routes/square.js";
import {
  authenticateKdsRequest,
  isTrustedWriteOrigin,
  resolveDisplayMerchant,
  resolveKdsMerchantId,
  resolveKdsRequestMerchant,
  resolveRequestedMerchantId
} from "./lib/kds-auth.js";

declare module "fastify" {
  interface FastifyRequest {
    // Resolved + access-checked store for /api/kds/* requests (ADR-0018,
    // Phase 5), set by the auth preHandler. null when none could be resolved.
    kdsMerchantId: string | null;
  }
}

export async function initializeAppServices(services: AppServices) {
  const bootstrapAdmin = await services.auth.bootstrapAdminAccount();
  // Multi-tenant (ADR-0818 / #902 Phase 0): make the single implicit tenant a real
  // provisioned row and guarantee the bootstrap admin carries a membership, so a
  // fresh install never relies on the env-default tenant fallback in
  // resolveAccountTenantId. Idempotent (skip-if-exists + upsert) — runs every boot
  // harmlessly. tenant-default is also seeded by the db-kds migration; this closes
  // the membership gap for a brand-new install whose admin is created here.
  await provisionTenant(services, {
    id: DEFAULT_TENANT_ID,
    name: "Example Kitchen",
    slug: "restaurant-ops-platform",
    owners: bootstrapAdmin ? [{ accountId: bootstrapAdmin.id, role: bootstrapAdmin.role }] : []
  });
  if (canBootstrapCloverMerchantFromEnv(services.config)) {
    await services.clover.bootstrapMerchantFromEnv();
    const providerState = await services.prisma.providerAppState.findUnique({
      where: cloverProviderStateWhere(services.config),
      select: { tokenModeMerchantId: true }
    });
    if (!providerState?.tokenModeMerchantId && services.config.cloverMerchantId) {
      await upsertCloverProviderState(services.prisma, services.config, {
        tokenModeMerchantId: services.config.cloverMerchantId
      });
    }
  }
  // Local/sandbox dev convenience: when SQUARE_ACCESS_TOKEN is set, auto-create
  // the Square PosAccount + PosStore from the token so the local polling loop has
  // a real store with no manual connect click. Best-effort/non-fatal (mirrors the
  // Clover startup philosophy) — a sandbox outage or bad dev token must not block
  // boot. Never logs the token (only the error name).
  if (canBootstrapSquareAccountFromEnv(services.config)) {
    try {
      await bootstrapSquareAccountFromEnv(services.prisma, services.config, services.square);
    } catch (err) {
      console.warn(
        JSON.stringify({
          level: "warn",
          scope: "square.bootstrap",
          msg: "square env bootstrap failed",
          kind: err instanceof SquareConnectError ? err.kind : err instanceof Error ? err.name : "unknown"
        })
      );
    }
  }

  await services.hub.start();

  // GH #170: validate the Clover token at boot so a stale/revoked credential is
  // visible in logs + the /api/ready probe immediately, not at the first failed
  // sync. Best-effort and non-fatal — a Clover outage must not block startup.
  await validateCloverTokenAtStartup(services.prisma, services.config, services.clover, {
    info: (obj, msg) => console.info(JSON.stringify({ level: "info", msg, ...(obj as object) })),
    warn: (obj, msg) => console.warn(JSON.stringify({ level: "warn", msg, ...(obj as object) }))
  });
}

export async function buildApp(providedServices?: AppServices) {
  const config = providedServices?.config ?? loadConfig();
  const services = providedServices ?? createServices(config);
  const logger = config.nodeEnv === "development"
    ? {
        transport: {
          target: "pino-pretty" as const
        }
      }
    : true;

  await initializeAppServices(services);

  // Adopt a caller-supplied `x-request-id` as Fastify's request.id, so a
  // correlation id from the backoffice BFF flows into every request.log line —
  // one id ties the BFF call and these logs together in Loki. Falls back to the
  // generated id when absent (order-web BFF, Clover webhooks, direct calls).
  const app = Fastify({
    logger,
    requestIdHeader: "x-request-id"
  });

  Sentry.setupFastifyErrorHandler(app);

  // Stamp the request's correlation id (request.id — the incoming x-request-id
  // adopted above, else generated) onto the Sentry scope, which is auto-isolated
  // per request on Node >=22.12. A captured error then carries the same id that
  // appears in the logs, so a Sentry issue pivots straight to Loki by one id.
  // No-op when Sentry isn't initialized (dev / empty DSN).
  app.addHook("onRequest", async (request) => {
    Sentry.setTag("request_id", request.id);
  });

  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }

      if (config.nodeEnv === "production") {
        callback(null, origin === new URL(config.appBaseUrl).origin);
        return;
      }

      callback(null, true);
    },
    credentials: true
  });
  await app.register(cookie);

  await app.register(websocket);

  // Per-request store resolved by the /api/kds/* preHandler (ADR-0018, Phase 5).
  app.decorateRequest("kdsMerchantId", null);

  app.get<{ Querystring: { merchantId?: string } }>("/ws", { websocket: true }, async (connection, request) => {
    const auth = await authenticateKdsRequest(services, request);
    if (!auth.ok) {
      connection.close();
      return;
    }

    const requestedMerchantId = resolveRequestedMerchantId(request);
    const merchantId = await resolveKdsMerchantId(services, auth.context, requestedMerchantId);
    if (!merchantId) {
      connection.close();
      return;
    }
    if (auth.context.type === "device" && auth.context.merchantId !== merchantId) {
      connection.close();
      return;
    }
    services.hub.attach(merchantId, connection);
  });

  app.get<{ Querystring: { merchantId?: string } }>("/ws/display", { websocket: true }, async (connection, request) => {
    // Staged on MULTITENANT_MODE (resolveDisplayMerchant): off/observe keep the
    // public ?merchantId= path; enforce requires the paired device token (it rides
    // the same-origin cookie on the WS upgrade). A rejection or no store → close.
    const resolved = await resolveDisplayMerchant(services, request);
    if (resolved.rejected || !resolved.merchantId) {
      connection.close();
      return;
    }
    services.hub.attachDisplay(resolved.merchantId, connection);
  });

  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api/kds/")) {
      return;
    }

    // Authenticate + resolve + (for devices) access-check the store this request
    // is authorized for. SECURITY (audit-2026-06-03 #470/#471/#472/#473): a
    // session is pinned to its account's authorized merchant here and CANNOT
    // choose another store via ?merchantId= — that resolved store is what every
    // downstream ticket-ownership guard checks against, so trusting the query
    // param would let a session read/edit/DELETE another merchant's tickets.
    // Devices stay bound to their paired store. Logic lives in one shared
    // helper so app + tests exercise the same path (resolveKdsRequestMerchant).
    const resolved = await resolveKdsRequestMerchant(services, request, reply);
    if (resolved.rejected) {
      // resolveKdsRequestMerchant already set reply.statusCode (401 or 403).
      // Send + `return reply` to halt the route (returning a bare object does
      // NOT reliably short-circuit a Fastify preHandler — a stale 4xx would be
      // sent but the route would still run; that would re-open the IDOR).
      reply.send({ error: reply.statusCode === 403 ? "Forbidden" : "Unauthorized" });
      return reply;
    }
    request.kdsMerchantId = resolved.merchantId;

    if (resolved.auth.type === "session" && ["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
      const origin = isTrustedWriteOrigin(request, services.config.appBaseUrl);
      if (!origin.ok) {
        reply.code(403).send({ error: "Untrusted origin.", expectedOrigin: origin.expected });
        return reply;
      }
    }
  });

  await registerAuthRoutes(app, services);
  await registerAdminRoutes(app, services);
  await registerHealthRoutes(app, services);
  await registerCloverRoutes(app, services);
  await registerDeliverectRoutes(app, services);
  await registerSquareRoutes(app, services);
  await registerInternalRoutes(app, services);
  await registerDlqRoutes(app, services);
  await registerKdsRoutes(app, services);
  await registerMetricsRoutes(app, services);
  await registerOrderRoutes(app, services);
  await registerPairingRoutes(app, services);

  app.addHook("onClose", async () => {
    await Promise.all([
      services.queue.close(),
      services.redisPublisher.quit(),
      services.redisSubscriber.quit(),
      services.prisma.$disconnect(),
      services.prismaAuth.$disconnect()
    ]);
  });

  return app;
}
