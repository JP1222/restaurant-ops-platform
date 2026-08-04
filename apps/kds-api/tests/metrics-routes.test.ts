import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppServices } from "../src/lib/services.js";
import { registerMetricsRoutes } from "../src/routes/metrics.js";

// GH #124: kds_dlq_size{job_type} must drop to absent once a job_type's
// dead-letters are resolved — otherwise a depth alert built on it would stay
// pinned at the last stale value after the DLQ is cleared. The route reset()s
// the gauge before re-setting from the (zero-omitting) groupBy.

function buildServices(groupBy: ReturnType<typeof vi.fn>): AppServices {
  return {
    queue: {
      depths: vi.fn(async () => ({ syncHi: 0, syncLo: 0, fulfillment: 0, scheduler: 0 }))
    },
    prisma: { deadLetterJob: { groupBy } }
  } as unknown as AppServices;
}

describe("GET /api/internal/metrics kds_dlq_size staleness (GH #124)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("clears a job_type's DLQ series after its dead-letters are resolved", async () => {
    const groupBy = vi
      .fn()
      .mockResolvedValueOnce([{ jobType: "sync-order", _count: { _all: 15 } }])
      .mockResolvedValueOnce([]); // all resolved on the next scrape
    const app = Fastify();
    await registerMetricsRoutes(app, buildServices(groupBy));

    const first = await app.inject({ method: "GET", url: "/api/internal/metrics" });
    expect(first.body).toContain('kds_dlq_size{job_type="sync-order"} 15');

    const second = await app.inject({ method: "GET", url: "/api/internal/metrics" });
    // Without the reset() this would still report 15 — pinning a depth alert open.
    expect(second.body).not.toContain('kds_dlq_size{job_type="sync-order"}');

    await app.close();
  });
});
