import type { AppConfig } from "../config.js";
import type { DbPool } from "../db.js";
import { createLogger, errorMessage } from "../lib/log.js";
import { advisoryKey, AdvisoryNamespace, withSessionAdvisoryLock } from "../scheduler/advisory-lock.js";
import { Heartbeat } from "../scheduler/heartbeat.js";
import { SyncWindowRepository } from "../scheduler/sync-window-repository.js";
import { refreshMartForRange } from "../transform/mart-loader.js";
import { DirtyWindowRepository, mergeDirtyWindows } from "./dirty-window-repository.js";
import { refreshMaterializedViewsThrottled } from "./mv-refresh.js";
import type { SyncTargetsReader } from "../sync-targets/repository.js";

type MartRefreshDependency = {
  refreshRange: typeof refreshMartForRange;
  refreshMaterializedViews: typeof refreshMaterializedViewsThrottled;
  withRefreshLock: <T>(merged: {
    merchantId: string;
    businessDateStart: string;
    businessDateEnd: string;
  }, task: () => Promise<T>) => Promise<T | null>;
};

const log = createLogger("refresh.mart");

export class MartRefreshWorker {
  private stopped = false;
  private readonly heartbeat: Heartbeat;
  private readonly dependency: MartRefreshDependency;

  constructor(
    private readonly pool: DbPool,
    private readonly config: AppConfig,
    private readonly syncTargets: SyncTargetsReader,
    dependency?: Partial<MartRefreshDependency>
  ) {
    this.heartbeat = new Heartbeat(pool, "mart-refresh-worker");
    this.dependency = {
      refreshRange: refreshMartForRange,
      refreshMaterializedViews: refreshMaterializedViewsThrottled,
      withRefreshLock: (merged, task) => withSessionAdvisoryLock(
        this.pool,
        AdvisoryNamespace.MartRefresh,
        advisoryKey(`${merged.merchantId}:${merged.businessDateStart}:${merged.businessDateEnd}`),
        task
      ),
      ...dependency
    };
  }

  start() {
    this.heartbeat.start();
    void this.loop();
  }

  stop() {
    this.stopped = true;
    this.heartbeat.stop();
  }

  private async loop() {
    while (!this.stopped) {
      try {
        await this.tick();
      } catch (error) {
        log.error(`Mart refresh worker failed: ${errorMessage(error)}`);
      }
      await sleep(this.config.martRefreshIntervalSeconds * 1000);
    }
  }

  async tick() {
    const repository = new DirtyWindowRepository(this.pool, this.config.storeTimezone);
    const syncWindows = new SyncWindowRepository(this.pool);
    let refreshedClaims = 0;
    await repository.recoverStaleRefreshing(this.config.jobStaleAfterMinutes);
    await repository.requeueRetryableFailures();
    while (!this.stopped) {
      const claim = await repository.claimPending();
      if (!claim) {
        break;
      }

      try {
        for (const merged of mergeDirtyWindows(claim.rows)) {
          // Per-store timezone (ADR-0018): the mart's local_hour/weekday/
          // business_date are computed against the store's own timezone, not a
          // global one. Falls back to the configured default if unset.
          const timezone = await this.syncTargets.timezoneFor(
            merged.merchantId,
            this.config.storeTimezone
          );
          // Resolve the provider so the mart reads the right raw.* source +
          // normalizer (ADR-0019). Default "clover" for a legacy/unset target so
          // existing single-provider behavior is unchanged.
          const target = await this.syncTargets.get(merged.merchantId);
          const provider = target?.provider ?? "clover";
          const refreshed = await this.dependency.withRefreshLock(
            merged,
            () => this.dependency.refreshRange(this.pool, {
              merchantId: merged.merchantId,
              start: merged.start,
              end: merged.end,
              timezone,
              provider
            })
          );
          if (refreshed === null) {
            throw new Error(`Mart refresh lock is busy for ${merged.merchantId} ${merged.businessDateStart}-${merged.businessDateEnd}.`);
          }
          await syncWindows.markMartRefreshed({
            merchantId: merged.merchantId,
            windowStart: merged.start,
            windowEnd: merged.end,
            metrics: {
              businessDateStart: merged.businessDateStart,
              businessDateEnd: merged.businessDateEnd
            }
          });
        }

        await repository.markRefreshed(claim.claimToken);
        refreshedClaims += 1;
      } catch (error) {
        await repository.markFailed(claim.claimToken, error);
        throw error;
      }
    }
    await this.dependency.refreshMaterializedViews(this.pool, this.config);
    return refreshedClaims;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
