import type { FastifyInstance } from "fastify";
import type { DeadLetterJob } from "@rop/db-kds";
import { createAdminBearerGuard } from "../lib/admin-bearer-auth.js";
import { NotReplayableError, replayDeadLetterJob } from "../lib/dlq-replay.js";
import type { AppServices } from "../lib/services.js";

// GH #124 / ADR-0727: operator tooling over the durable DeadLetterJob table (the
// kds DLQ). Auth-gated by the internal-admin bearer — operator/BFF only, never a
// Floor session. The depth metric + alert already ship (kds_dlq_size, #722); this
// adds list + replay + resolve so a stuck order isn't recoverable only by hand-
// querying Postgres.

function serializeDeadLetterJob(row: DeadLetterJob) {
  return {
    id: row.id,
    merchantId: row.merchantId,
    jobType: row.jobType,
    reason: row.reason,
    attempts: row.attempts,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null
  };
}

const LIST_LIMIT_DEFAULT = 100;
const LIST_LIMIT_MAX = 500;

export async function registerDlqRoutes(app: FastifyInstance, services: AppServices) {
  const adminBearer = createAdminBearerGuard(services.config.kdsInternalAdminToken);

  // List dead-letter rows. Defaults to UNRESOLVED (the actionable set);
  // ?resolved=true → only resolved, ?resolved=all → both. Optional ?jobType= filter.
  app.get<{ Querystring: { resolved?: string; jobType?: string; limit?: string } }>(
    "/api/admin/dlq",
    { preHandler: adminBearer },
    async (request) => {
      const { resolved, jobType } = request.query;
      const limit = Math.min(Math.max(Number(request.query.limit) || LIST_LIMIT_DEFAULT, 1), LIST_LIMIT_MAX);
      const resolvedWhere =
        resolved === "all" ? {} : resolved === "true" ? { resolvedAt: { not: null } } : { resolvedAt: null };

      const rows = await services.prisma.deadLetterJob.findMany({
        where: {
          ...resolvedWhere,
          ...(jobType ? { jobType } : {})
        },
        orderBy: { createdAt: "desc" },
        take: limit
      });
      return { jobs: rows.map(serializeDeadLetterJob) };
    }
  );

  // Replay: re-enqueue the stored job onto its original queue, then mark resolved.
  // Idempotent at the sync layer (ADR-0727). 404 missing, 409 already resolved,
  // 422 a job type this endpoint won't re-drive (use /resolve).
  app.post<{ Params: { id: string } }>(
    "/api/admin/dlq/:id/replay",
    { preHandler: adminBearer },
    async (request, reply) => {
      const row = await services.prisma.deadLetterJob.findUnique({ where: { id: request.params.id } });
      if (!row) {
        reply.code(404);
        return { error: "Dead-letter job not found." };
      }
      if (row.resolvedAt) {
        reply.code(409);
        return { error: "Dead-letter job is already resolved." };
      }
      try {
        await replayDeadLetterJob(services.queue, row);
      } catch (err) {
        if (err instanceof NotReplayableError) {
          reply.code(422);
          return { error: err.message };
        }
        throw err;
      }
      // Only mark resolved AFTER the re-enqueue succeeds, so a failed enqueue
      // leaves the row actionable (mirrors the "advance only on success" rule).
      const resolved = await services.prisma.deadLetterJob.update({
        where: { id: row.id },
        data: { resolvedAt: new Date() }
      });
      return { ok: true, replayed: true, job: serializeDeadLetterJob(resolved) };
    }
  );

  // Resolve WITHOUT replay — for a row the operator handled out-of-band or judged
  // unreplayable (a permanent contract bug). Idempotent-ish: 404 missing, 409 if
  // already resolved.
  app.post<{ Params: { id: string } }>(
    "/api/admin/dlq/:id/resolve",
    { preHandler: adminBearer },
    async (request, reply) => {
      const result = await services.prisma.deadLetterJob.updateMany({
        where: { id: request.params.id, resolvedAt: null },
        data: { resolvedAt: new Date() }
      });
      if (result.count === 0) {
        const exists = await services.prisma.deadLetterJob.findUnique({
          where: { id: request.params.id },
          select: { id: true }
        });
        reply.code(exists ? 409 : 404);
        return { error: exists ? "Dead-letter job is already resolved." : "Dead-letter job not found." };
      }
      return { ok: true, resolved: true };
    }
  );
}
