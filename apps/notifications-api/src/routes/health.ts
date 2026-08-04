import type { FastifyInstance } from "fastify";

import type { AppServices } from "../lib/services.js";

export async function registerHealthRoutes(app: FastifyInstance, services: AppServices) {
  // Liveness: process is up. No dependencies touched, so a slow DB never trips it.
  app.get("/api/health", async () => ({ ok: true, now: new Date().toISOString() }));

  // Readiness: can serve real traffic. Exercises Postgres via Prisma. Returns 503
  // with a per-check body when the database is unreachable.
  app.get("/api/ready", async (_request, reply) => {
    const checks: Record<string, string> = {};
    try {
      await services.prisma.$queryRaw`SELECT 1`;
      checks.database = "ok";
    } catch (err) {
      app.log.error({ err }, "readiness database check failed");
      checks.database = "unhealthy";
    }
    const allOk = Object.values(checks).every((value) => value === "ok");
    return reply.code(allOk ? 200 : 503).send({
      ok: allOk,
      now: new Date().toISOString(),
      checks
    });
  });
}
