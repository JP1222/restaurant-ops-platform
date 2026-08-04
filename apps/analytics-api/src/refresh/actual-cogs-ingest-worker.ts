import type { AppConfig } from "../config.js";
import type { DbPool } from "../db.js";
import { fetchActualCogs } from "../inventory/client.js";
import { ingestActualCogs } from "../inventory/ingest-actual-cogs.js";
import { createLogger, errorMessage } from "../lib/log.js";
import { Heartbeat } from "../scheduler/heartbeat.js";

const log = createLogger("refresh.actual-cogs");

type ActualCogsIngestDependency = {
  fetch: typeof fetchActualCogs;
  ingest: typeof ingestActualCogs;
};

/**
 * Periodically pulls count-based actual COGS from inventory-api into
 * `mart.dim_actual_cogs` (ADR-0573 follow-up).
 *
 * A Backoffice count already fires an immediate sync (POST
 * /admin/api/sync-actual-cogs), but **crew-web floor counts** post straight to
 * inventory-api with no analytics trigger — this worker is what catches those up,
 * so yield variance reflects floor activity without a manager action.
 *
 * Ingest only: it upserts dim_actual_cogs and stops. The mart-refresh-worker
 * refreshes `cost_variance_daily_mv` on its own (throttled) cadence, so the next
 * refresh picks up the freshly-ingested windows — no double-refresh here.
 *
 * Best-effort by design: inventory-api being unreachable or unconfigured logs a
 * warning and the loop continues. The next tick (or a Backoffice count) recovers.
 */
export class ActualCogsIngestWorker {
  private stopped = false;
  private readonly heartbeat: Heartbeat;
  private readonly dependency: ActualCogsIngestDependency;

  constructor(
    private readonly pool: DbPool,
    private readonly config: AppConfig,
    dependency?: Partial<ActualCogsIngestDependency>
  ) {
    this.heartbeat = new Heartbeat(pool, "actual-cogs-ingest-worker");
    this.dependency = { fetch: fetchActualCogs, ingest: ingestActualCogs, ...dependency };
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
      await this.tick();
      await sleep(this.config.actualCogsIngestIntervalSeconds * 1000);
    }
  }

  /** One pull + upsert. Returns the number of windows written (0 on a skipped pull). */
  async tick(): Promise<number> {
    try {
      const { snapshots } = await this.dependency.fetch(this.config);
      const result = await this.dependency.ingest(this.pool, snapshots);
      return result.written;
    } catch (error) {
      log.warn(`Actual-COGS ingest skipped: ${errorMessage(error)}`);
      return 0;
    }
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
