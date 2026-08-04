import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AppConfig } from "../config.js";

// Generic, client-safe message for a redacted 5xx. Never leak the underlying
// exception (Prisma column names, the "missing waste_settings (run the seed)"
// bootstrap error, stack traces) to the floor app in production.
const GENERIC_500 = "Internal server error";

// Map well-known Prisma error codes to a client-meaningful status + a generic
// message. We duck-type on `.code` (same pattern as lib/crew-admin.ts) rather
// than importing PrismaClientKnownRequestError so this stays decoupled from the
// generated client's runtime shape. The message is deliberately generic — the
// real Prisma detail (constraint name, column, table) goes to the log only.
const PRISMA_STATUS: Record<string, { status: number; message: string }> = {
  // Foreign-key constraint failed — the request referenced something that
  // doesn't exist (or can't be removed because it's referenced). Client error.
  P2003: { status: 400, message: "Invalid reference" },
  // "An operation failed because it depends on one or more records that were
  // required but not found" — the target row is gone. Treat as 404.
  P2025: { status: 404, message: "Not found" }
};

function prismaCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && /^P\d{4}$/.test(code)) {
      return code;
    }
  }
  return undefined;
}

// Centralized error + not-found handlers. Installed once in buildApp.
//
// Goals (issue #152):
//   - log the full error server-side via req.log.error (never to the client),
//   - in production return only a generic message + request_id (no stack, no
//     Prisma internals, no raw exception text),
//   - map known Prisma codes to a sane status with a generic body,
//   - return a stable request_id (Fastify's request.id) in the body AND an
//     `x-request-id` header so a floor report can be correlated to a log line,
//   - never echo the requested path on a 404.
//
// In development / test the real message is still returned so local debugging
// and the existing assertion-by-message tests keep working; only production is
// redacted. Explicitly-thrown 4xx (Fastify validation, malformed JSON body)
// keep their status — those messages are already safe and client-actionable.
export function registerErrorHandlers(app: FastifyInstance, config: AppConfig): void {
  const isProd = config.nodeEnv === "production";

  app.setErrorHandler((err: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const requestId = request.id;
    reply.header("x-request-id", requestId);

    // Known Prisma failure → deterministic client status + generic message.
    const code = prismaCode(err);
    if (code && PRISMA_STATUS[code]) {
      const mapped = PRISMA_STATUS[code];
      // Log the full Prisma error (code + meta) for operators; never to client.
      request.log.error({ err, prismaCode: code }, "prisma error mapped to client status");
      return reply.code(mapped.status).send({ error: mapped.message, request_id: requestId });
    }

    // Fastify attaches a statusCode to its own errors (validation = 400, body
    // parse = 400, etc.). Honor any client-error (4xx) status: those are safe,
    // expected, and already carry a useful message. Anything 5xx or unset is an
    // unexpected server fault and gets redacted in production.
    const status = typeof err.statusCode === "number" ? err.statusCode : 500;

    if (status >= 500) {
      request.log.error({ err }, "unhandled error");
      return reply.code(status).send({
        error: isProd ? GENERIC_500 : err.message || GENERIC_500,
        request_id: requestId
      });
    }

    // 4xx: log at warn (not error) and pass the message through — it's a client
    // problem, not a server fault, and the message is already safe.
    request.log.warn({ err, statusCode: status }, "request error");
    return reply.code(status).send({
      error: err.message || "Bad request",
      request_id: requestId
    });
  });

  // Unknown route. Do NOT echo the requested path (Fastify's default 404 body
  // includes the method + url) — keep the surface area for probing minimal.
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const requestId = request.id;
    reply.header("x-request-id", requestId);
    return reply.code(404).send({ error: "Not found", request_id: requestId });
  });
}
