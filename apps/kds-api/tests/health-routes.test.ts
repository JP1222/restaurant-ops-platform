import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppServices } from "../src/lib/services.js";
import { registerHealthRoutes } from "../src/routes/health.js";

// GH #154: /api/ready surfaces Clover sync freshness so a stalled sync (no new
// tickets reaching the kitchen) stops showing green — WITHOUT flipping the
// deploy-gating 503 (a stale sync is operator-actionable, not a deploy failure).

type ReadyBody = {
  ok: boolean;
  checks: Record<string, string>;
  cloverLastSync: string | null;
  cloverLagSeconds: number | null;
};

function buildServices(opts: {
  dbOk?: boolean;
  lastSyncAt?: Date | null;
  lastReconciledAt?: Date | null;
  lastWebhookAt?: Date | null;
  merchant?: boolean;
  maxAgeMinutes?: number;
}): AppServices {
  const {
    dbOk = true,
    lastSyncAt = null,
    lastReconciledAt = null,
    lastWebhookAt = null,
    merchant = true,
    maxAgeMinutes = 90
  } = opts;
  return {
    config: { cloverSyncMaxAgeMinutes: maxAgeMinutes },
    prisma: {
      $queryRaw: vi.fn(async () => {
        if (!dbOk) throw new Error("db down");
        return [{ "?column?": 1 }];
      }),
      cloverMerchant: {
        findFirst: vi.fn(async () =>
          merchant ? { lastSyncAt, lastReconciledAt, lastWebhookAt } : null
        )
      }
    },
    redisPublisher: { ping: vi.fn(async () => "PONG") }
  } as unknown as AppServices;
}

async function ready(services: AppServices) {
  const app = Fastify();
  const warn = vi.spyOn(app.log, "warn").mockImplementation(() => true as never);
  await registerHealthRoutes(app, services);
  const res = await app.inject({ method: "GET", url: "/api/ready" });
  await app.close();
  return { res, body: res.json() as ReadyBody, warn };
}

describe("GET /api/ready Clover sync freshness (GH #154)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reports cloverSync ok + a small lag for a fresh sync, no warn", async () => {
    const { res, body, warn } = await ready(
      buildServices({ lastSyncAt: new Date(Date.now() - 60_000) })
    );
    expect(res.statusCode).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.checks.cloverSync).toBe("ok");
    expect(body.cloverLagSeconds).toBeGreaterThanOrEqual(0);
    expect(body.cloverLagSeconds).toBeLessThan(90 * 60);
    expect(body.cloverLastSync).not.toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("stays ok during a quiet period: old lastSyncAt but a fresh reconciliation poll", async () => {
    // The bug this fixes: lastSyncAt only bumps per ORDER, so an overnight
    // closure (no orders) looked "stale" even though the recon poll proves the
    // pipeline is alive. Liveness keys on the most recent of the three stamps.
    const { res, body, warn } = await ready(
      buildServices({
        lastSyncAt: new Date(Date.now() - 5 * 60 * 60 * 1000), // 5h since last order
        lastReconciledAt: new Date(Date.now() - 30_000) // recon ran 30s ago
      })
    );
    expect(res.statusCode).toBe(200);
    expect(body.checks.cloverSync).toBe("ok");
    expect(body.cloverLagSeconds).toBeLessThan(90 * 60);
    expect(warn).not.toHaveBeenCalled();
  });

  it("flags stale only when ALL of order/recon/webhook are old, and does NOT flip the 503 gate", async () => {
    const stale = new Date(Date.now() - 3 * 60 * 60 * 1000); // 3h ago, threshold 90m
    const { res, body, warn } = await ready(
      buildServices({ lastSyncAt: stale, lastReconciledAt: stale, lastWebhookAt: stale })
    );
    // Gate stays green — db + redis are healthy; sync staleness is diagnostic.
    expect(res.statusCode).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.checks.cloverSync).toMatch(/^stale: /);
    expect(body.cloverLagSeconds).toBeGreaterThan(90 * 60);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ scope: "kds.api.ready.clover" });
  });

  it("reports no-merchant / never-synced without a lag value", async () => {
    const none = await ready(buildServices({ merchant: false }));
    expect(none.body.checks.cloverSync).toBe("no-merchant");
    expect(none.body.cloverLastSync).toBeNull();
    expect(none.body.cloverLagSeconds).toBeNull();

    const never = await ready(buildServices({ lastSyncAt: null }));
    expect(never.body.checks.cloverSync).toBe("never-synced");
    expect(never.body.cloverLagSeconds).toBeNull();
  });

  it("still computes sync freshness independently when the DB gate trips 503", async () => {
    // db down → 503, but the freshness probe is its own query and still runs.
    const { res, body } = await ready(
      buildServices({ dbOk: false, lastSyncAt: new Date(Date.now() - 60_000) })
    );
    expect(res.statusCode).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.checks.database).not.toBe("ok");
    expect(body.checks.cloverSync).toBe("ok");
  });
});
