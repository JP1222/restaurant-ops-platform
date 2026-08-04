import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

export function createAdminBearerGuard(token: string | undefined) {
  return async function adminBearerGuard(request: FastifyRequest, reply: FastifyReply) {
    if (!token) {
      reply.code(503);
      return reply.send({ error: "internal_admin_disabled" });
    }

    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) {
      reply.code(401);
      return reply.send({ error: "missing_bearer" });
    }

    const presented = header.slice("Bearer ".length).trim();
    if (presented.length === 0 || !constantTimeEqual(presented, token)) {
      reply.code(401);
      return reply.send({ error: "invalid_bearer" });
    }
  };
}

function constantTimeEqual(a: string, b: string) {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) {
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}
