import * as Sentry from "@sentry/node";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import Fastify, { type FastifyRequest } from "fastify";

import { createServices, type AppServices } from "./lib/services.js";
import { readCrewSession, resolveActor } from "./lib/crew-auth.js";
import { registerErrorHandlers } from "./lib/error-handler.js";
import { matchesInternalBearer } from "./lib/internal-bearer.js";
import { registerCrewAdminRoutes } from "./routes/admin-crew.js";
import { registerCrewAuthRoutes } from "./routes/crew-auth.js";
import { registerActualCogsRoutes } from "./routes/actual-cogs.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerInventoryRoutes } from "./routes/inventory.js";
import { registerLaborCostRoutes } from "./routes/labor-cost.js";

function requestOrigin(request: FastifyRequest): string | null {
  const origin = request.headers.origin;
  if (typeof origin === "string" && origin) {
    return origin;
  }
  const referer = request.headers.referer;
  if (typeof referer === "string" && referer) {
    try {
      return new URL(referer).origin;
    } catch {
      return referer;
    }
  }
  return null;
}

export async function buildApp(providedServices?: AppServices) {
  const services = providedServices ?? createServices();
  const { config, prisma } = services;

  const logger =
    config.nodeEnv === "development" ? { transport: { target: "pino-pretty" as const } } : true;

  // Trust X-Forwarded-* only from configured proxy IPs/CIDRs. Without this the
  // PIN limiter keys on the ingress IP and every device shares one bucket
  // (issue #121). An empty list keeps XFF rejected, which is what tests + dev
  // direct-connect want; production must set TRUST_PROXY_CIDR to its overlay
  // (e.g. "10.0.0.0/8,172.16.0.0/12") so spoofed XFF from outside the proxy
  // network is still ignored.
  const trustProxy = config.trustProxyCidr
    ? config.trustProxyCidr.split(",").map((s) => s.trim()).filter(Boolean)
    : false;

  // Adopt a caller-supplied `x-request-id` as Fastify's request.id (instead of
  // the default generated `req-N`), so a correlation id set by the backoffice
  // BFF flows into every request.log line and the existing x-request-id error
  // header — one id ties the BFF call and these logs together in Loki. Falls
  // back to the generated id when absent (e.g. crew app, direct calls).
  const app = Fastify({ logger, trustProxy, requestIdHeader: "x-request-id" });

  // Capture 5xx errors to Sentry via its onError hook (no-op without a DSN —
  // dev / test / empty DSN). It COEXISTS with the redacting setErrorHandler
  // installed below: the hook only observes + reports, it never produces the
  // client response, so production error redaction (issue #152) is unchanged.
  Sentry.setupFastifyErrorHandler(app);
  // Stamp the request's correlation id (request.id — the incoming x-request-id
  // adopted above, else generated) onto the per-request Sentry scope so a
  // captured error carries the same id as the logs (Node >=22.12 auto-isolates
  // the scope per request). No-op when Sentry isn't initialized.
  app.addHook("onRequest", async (request) => {
    Sentry.setTag("request_id", request.id);
  });

  // Redact internals + return a stable request_id on errors (issue #152).
  // Installed before routes so every handler — including the auth guards below
  // — is covered, and a thrown Prisma/bootstrap error never reaches the floor
  // app verbatim in production.
  registerErrorHandlers(app, config);

  const allowedOrigins = new Set([
    new URL(config.backofficeBaseUrl).origin,
    new URL(config.crewBaseUrl).origin
  ]);

  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }
      if (config.nodeEnv === "production") {
        callback(null, allowedOrigins.has(origin));
        return;
      }
      callback(null, true);
    },
    credentials: true
  });
  await app.register(cookie);

  // Write guard. Reads are open and `/api/crew/*` handles its own auth. Inventory
  // writes accept either a valid crew session (floor app) or the internal bearer
  // token (trusted backoffice BFF); the crew session is tried first so a stale
  // cookie never blocks a valid bearer. Fails closed in production when neither a
  // crew session nor a configured bearer token is present.
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api/inventory") || request.method === "GET") {
      return;
    }
    // Crew path: a present session cookie must resolve to an *active* employee.
    // resolveActor re-checks the DB, so a disabled/removed employee's still-valid
    // token is rejected here rather than silently falling through to the bearer.
    if (readCrewSession(request, config)) {
      // CSRF guard: the crew cookie alone authorizes a write, so a cross-site
      // form post would ride it. A browser always stamps Origin/Referer on a
      // cross-origin POST, and an attacker can't forge an allowed one, so reject
      // any present origin outside `allowedOrigins`. Dev trusts all origins to
      // match the CORS block above.
      if (config.nodeEnv === "production") {
        const origin = requestOrigin(request);
        if (origin && !allowedOrigins.has(origin)) {
          return reply.code(403).send({ error: "Untrusted origin" });
        }
      }
      if (await resolveActor(prisma, request, config)) {
        return;
      }
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const token = config.internalToken;
    if (config.nodeEnv === "production" && !token) {
      return reply.code(503).send({ error: "Inventory write auth not configured" });
    }
    if (token && !matchesInternalBearer(request.headers.authorization, token)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
  });

  // Admin guard. Crew employee management is manager-only: it requires the
  // internal bearer token (trusted backoffice BFF) and never accepts a crew
  // session, so a logged-in cook cannot manage employees. Fails closed in
  // production when no token is configured.
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api/admin")) {
      return;
    }
    const token = config.internalToken;
    if (config.nodeEnv === "production" && !token) {
      return reply.code(503).send({ error: "Admin auth not configured" });
    }
    if (token && !matchesInternalBearer(request.headers.authorization, token)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
  });

  await registerHealthRoutes(app, services);
  await registerCrewAuthRoutes(app, services);
  await registerCrewAdminRoutes(app, services);
  await registerInventoryRoutes(app, services);
  await registerLaborCostRoutes(app, services);
  await registerActualCogsRoutes(app, services);

  app.addHook("onClose", async () => {
    await services.prisma.$disconnect();
  });

  return app;
}
