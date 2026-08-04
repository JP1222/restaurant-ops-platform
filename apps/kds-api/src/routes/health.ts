import type { FastifyInstance } from "fastify";
import { getCloverStartupValidation } from "../lib/clover-startup-validation.js";
import type { AppServices } from "../lib/services.js";

export async function registerHealthRoutes(app: FastifyInstance, services: AppServices) {
  // Liveness: Fastify process is up. Used by Traefik / load balancers to detect a
  // crashed process. Intentionally trivial — no external dependencies, so a slow
  // database or a flapping Redis never causes a liveness flap that triggers a
  // restart loop.
  app.get("/api/health", async () => ({
    ok: true,
    now: new Date().toISOString()
  }));

  // Readiness: app can actually serve real traffic. Exercises the dependencies
  // a real request would touch (Postgres via Prisma, Redis). Returns 503 with a
  // per-check diagnostic body when any dependency is down. Deploy gating uses the
  // compose healthcheck (/api/health) via scripts/deploy-stack.sh's
  // `docker compose up --wait`; wiring a deeper /api/ready probe into the deploy
  // is an available follow-up, not yet done.
  app.get("/api/ready", async (_request, reply) => {
    const checks: Record<string, string> = {};

    try {
      await services.prisma.$queryRaw`SELECT 1`;
      checks.database = "ok";
    } catch (err) {
      checks.database = err instanceof Error ? err.message : "failed";
    }

    try {
      const pong: string = await services.redisPublisher.ping();
      checks.redis = pong === "PONG" ? "ok" : `unexpected response: ${pong}`;
    } catch (err) {
      checks.redis = err instanceof Error ? err.message : "failed";
    }

    // Readiness gate covers only the dependencies a real request must touch.
    // Compute it BEFORE folding in the Clover diagnostic below so a stale Clover
    // token (operator-fixable via re-auth) can never trigger a deploy rollback.
    const allOk = Object.values(checks).every((value) => value === "ok");

    // GH #170: surface the boot-time Clover token validation as a diagnostic.
    // Informational only — it does not affect `ok`/the 503 gate, but a persistent
    // `failed` here tells an operator the configured token is stale/revoked.
    const cloverValidation = getCloverStartupValidation();
    if (cloverValidation) {
      checks.cloverToken =
        cloverValidation.state === "ok"
          ? "ok"
          : cloverValidation.state === "skipped"
            ? `skipped: ${cloverValidation.reason}`
            : `failed: ${cloverValidation.reason}`;
    }

    // GH #154: surface Clover sync freshness. A stalled sync worker or a
    // multi-hour Clover outage means no new tickets reach the kitchen while
    // every probe stays green. Like cloverToken above this is DIAGNOSTIC ONLY —
    // computed after `allOk` so a stale sync (operator-actionable) can never
    // flip the deploy-gating 503.
    //
    // Liveness = the most recent of {a synced order, a successful reconciliation
    // poll, a webhook}. Keying on lastSyncAt ALONE false-flagged "stale" during
    // any quiet period — it only bumps per ORDER, so an overnight closure with
    // no orders looked broken even though the recon poll (every ~45s) proved the
    // pipeline alive. lastReconciledAt is bumped ONLY after a successful Clover
    // fetch (reconciliation.ts), so a genuine outage / bad token freezes all
    // three timestamps and this correctly flags stale.
    let cloverLastSync: string | null = null;
    let cloverLagSeconds: number | null = null;
    try {
      const merchant = await services.prisma.cloverMerchant.findFirst({
        orderBy: { updatedAt: "desc" },
        select: { lastSyncAt: true, lastReconciledAt: true, lastWebhookAt: true }
      });
      if (!merchant) {
        // Fresh install / pre-OAuth — no merchant configured yet.
        checks.cloverSync = "no-merchant";
      } else {
        const stamps = [merchant.lastSyncAt, merchant.lastReconciledAt, merchant.lastWebhookAt].filter(
          (d): d is Date => d != null
        );
        if (stamps.length === 0) {
          // Merchant exists but nothing has synced/reconciled yet. Not stale, not "ok".
          checks.cloverSync = "never-synced";
        } else {
          const lastActivity = new Date(Math.max(...stamps.map((d) => d.getTime())));
          cloverLastSync = lastActivity.toISOString();
          cloverLagSeconds = Math.round((Date.now() - lastActivity.getTime()) / 1000);
          const thresholdSeconds = services.config.cloverSyncMaxAgeMinutes * 60;
          if (cloverLagSeconds > thresholdSeconds) {
            checks.cloverSync = `stale: ${cloverLagSeconds}s since last sync activity (threshold ${thresholdSeconds}s)`;
            app.log.warn(
              {
                scope: "kds.api.ready.clover",
                lagSeconds: cloverLagSeconds,
                thresholdSeconds,
                lastActivityAt: cloverLastSync
              },
              "Clover sync is stale"
            );
          } else {
            checks.cloverSync = "ok";
          }
        }
      }
    } catch (err) {
      checks.cloverSync = err instanceof Error ? err.message : "failed";
    }

    return reply.code(allOk ? 200 : 503).send({
      ok: allOk,
      now: new Date().toISOString(),
      checks,
      cloverLastSync,
      cloverLagSeconds
    });
  });
}
