import * as Sentry from "@sentry/node";
import cors from "@fastify/cors";
import Fastify from "fastify";

import { createServices, type AppServices } from "./lib/services.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerNotificationRoutes } from "./routes/notifications.js";
import { registerPrefsRoutes } from "./routes/prefs.js";

export async function buildApp(providedServices?: AppServices) {
  const services = providedServices ?? createServices();
  const { config } = services;

  const logger =
    config.nodeEnv === "development" ? { transport: { target: "pino-pretty" as const } } : true;

  // Adopt a caller-supplied `x-request-id` as Fastify's request.id so the BFF's
  // correlation id flows into every request.log line; falls back to the
  // generated id. Matches kds-api / crm-api.
  const app = Fastify({ logger, requestIdHeader: "x-request-id" });

  Sentry.setupFastifyErrorHandler(app);
  app.addHook("onRequest", async (request) => {
    Sentry.setTag("request_id", request.id);
  });

  const allowedOrigins = config.allowedOrigins
    ? new Set(config.allowedOrigins.split(",").map((s) => s.trim()).filter(Boolean))
    : null;

  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin || config.nodeEnv !== "production" || !allowedOrigins) {
        callback(null, true);
        return;
      }
      callback(null, allowedOrigins.has(origin));
    },
    credentials: true
  });

  // Bearer guard. notifications-api is internal-only: every /api/notifications
  // route requires the BFF's bearer token. Health/readiness are exempt. Fails
  // closed in production when no token is configured.
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api/notifications")) {
      return;
    }
    const token = config.internalToken;
    if (config.nodeEnv === "production" && !token) {
      return reply.code(503).send({ error: "notifications-api auth not configured" });
    }
    if (token && request.headers.authorization !== `Bearer ${token}`) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
  });

  await registerHealthRoutes(app, services);
  await registerNotificationRoutes(app, services);
  await registerPrefsRoutes(app, services);

  app.addHook("onClose", async () => {
    await services.prisma.$disconnect();
  });

  return app;
}
