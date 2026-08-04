import * as Sentry from "@sentry/node";
import cors from "@fastify/cors";
import Fastify from "fastify";

import { createServices, type AppServices } from "./lib/services.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerLoyaltyRoutes } from "./routes/loyalty.js";

export async function buildApp(providedServices?: AppServices) {
  const services = providedServices ?? createServices();
  const { config } = services;

  const logger =
    config.nodeEnv === "development" ? { transport: { target: "pino-pretty" as const } } : true;

  // Adopt a caller-supplied `x-request-id` as Fastify's request.id so a future
  // BFF->crm correlation id flows into every request.log line; falls back to the
  // generated id today (no caller sends one yet). Matches kds-api/inventory-api.
  const app = Fastify({ logger, requestIdHeader: "x-request-id" });

  // Capture 5xx errors to Sentry via its onError hook (no-op without a DSN) and
  // stamp the request id on the per-request scope so an issue pivots to the logs.
  Sentry.setupFastifyErrorHandler(app);
  app.addHook("onRequest", async (request) => {
    Sentry.setTag("request_id", request.id);
  });

  const allowedOrigins = config.allowedOrigins
    ? new Set(config.allowedOrigins.split(",").map((s) => s.trim()).filter(Boolean))
    : null;

  await app.register(cors, {
    origin: (origin, callback) => {
      // No browser Origin (server-to-server), non-prod, or no allowlist set ->
      // permit. In production, restrict to the configured customer/operator origins.
      if (!origin || config.nodeEnv !== "production" || !allowedOrigins) {
        callback(null, true);
        return;
      }
      callback(null, allowedOrigins.has(origin));
    },
    credentials: true
  });

  // Bearer guard. The reward catalog (GET /api/loyalty/rewards) is public;
  // everything else under /api/loyalty — enrollment + the PII reads
  // (balance / history) — requires the internal bearer token (the trusted BFF in
  // order-web / marketing-site / backoffice). Fails closed in production when no
  // token is configured. Customer-session auth (SMS OTP) is a later phase; until
  // then PII reads are BFF-only, never exposed directly to the browser.
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api/loyalty")) {
      return;
    }
    if (request.method === "GET" && request.url.startsWith("/api/loyalty/rewards")) {
      return;
    }
    const token = config.internalToken;
    if (config.nodeEnv === "production" && !token) {
      return reply.code(503).send({ error: "crm-api auth not configured" });
    }
    if (token && request.headers.authorization !== `Bearer ${token}`) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
  });

  await registerHealthRoutes(app, services);
  await registerLoyaltyRoutes(app, services);

  app.addHook("onClose", async () => {
    await services.prisma.$disconnect();
  });

  return app;
}
