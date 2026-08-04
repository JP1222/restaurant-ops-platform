import type { FastifyInstance } from "fastify";
import { kdsDlqSize, kdsQueueDepth, metricsRegister } from "../lib/metrics.js";
import type { AppServices } from "../lib/services.js";

export async function registerMetricsRoutes(app: FastifyInstance, services: AppServices) {
  app.get("/api/internal/metrics", async (_request, reply) => {
    const [depths, deadLetters] = await Promise.all([
      services.queue.depths(),
      services.prisma.deadLetterJob.groupBy({
        by: ["jobType"],
        _count: { _all: true },
        where: { resolvedAt: null }
      })
    ]);

    for (const [queue, depth] of Object.entries(depths)) {
      kdsQueueDepth.set({ queue }, depth);
    }
    // Reset before re-setting: the groupBy only returns job_types that currently
    // have >=1 unresolved row, so a job_type whose dead-letters were all resolved
    // would otherwise keep its last (stale, non-zero) value forever — which would
    // pin a depth alert open after the DLQ is cleared (GH #124). reset() drops
    // those series to absent; only currently-failing job_types are re-set below.
    kdsDlqSize.reset();
    for (const row of deadLetters) {
      kdsDlqSize.set({ job_type: row.jobType }, row._count._all);
    }

    reply.header("content-type", metricsRegister.contentType);
    return metricsRegister.metrics();
  });
}
