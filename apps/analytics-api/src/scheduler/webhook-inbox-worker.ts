import type { AppConfig } from "../config.js";
import type { DbPool } from "../db.js";
import { createLogger, errorMessage } from "../lib/log.js";
import type { JsonRecord } from "../types.js";
import { enqueueForUpdate, type ParsedUpdate } from "../http/webhooks.js";
import { JobRepository } from "./job-repository.js";
import { Heartbeat } from "./heartbeat.js";
import type { SyncTargetsReader } from "../sync-targets/repository.js";

const log = createLogger("scheduler.webhook-inbox");

type WebhookInboxRow = {
  id: string;
  merchant_id: string;
  object_id: string;
  object_type: string;
  event_type: string;
  event_ts: Date | null;
  raw_event: JsonRecord;
  dedupe_key: string;
  attempt_count: number;
  max_attempts: number;
};

export class WebhookInboxWorker {
  private stopped = false;
  private readonly jobs: JobRepository;
  private readonly heartbeat: Heartbeat;

  constructor(
    private readonly pool: DbPool,
    private readonly config: AppConfig,
    private readonly syncTargets: SyncTargetsReader
  ) {
    this.jobs = new JobRepository(pool);
    this.heartbeat = new Heartbeat(pool, "webhook-inbox-worker");
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
        const processed = await this.tick();
        if (processed === 0) {
          await sleep(this.config.webhookInboxPollMs);
        }
      } catch (error) {
        log.error(`Webhook inbox worker failed: ${errorMessage(error)}`);
        await sleep(2000);
      }
    }
  }

  async tick() {
    await this.recoverStaleProcessing();
    const rows = await this.claimPending();
    await this.processRows(rows);
    return rows.length;
  }

  private async recoverStaleProcessing() {
    await this.pool.query(
      `
        UPDATE audit.webhook_inbox
        SET status = 'pending',
            locked_at = null,
            locked_by = null,
            last_recovered_at = now()
        WHERE status = 'processing'
          AND locked_at < now() - ($1::text)::interval
      `,
      [`${this.config.jobStaleAfterMinutes} minutes`]
    );
  }

  private async claimPending() {
    const result = await this.pool.query<WebhookInboxRow>(
      `
        UPDATE audit.webhook_inbox
        SET status = 'processing',
            locked_at = now(),
            locked_by = $1,
            attempt_count = attempt_count + 1
        WHERE id IN (
          SELECT id
          FROM audit.webhook_inbox
          WHERE status = 'pending'
            AND run_after <= now()
          ORDER BY received_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT $2
        )
        RETURNING
          id, merchant_id, object_id, object_type, event_type, event_ts,
          raw_event, dedupe_key, attempt_count, max_attempts
      `,
      [this.heartbeat.id(), this.config.webhookInboxBatchSize]
    );
    return result.rows;
  }

  private async processRows(rows: WebhookInboxRow[]) {
    const miniSweepCandidates = new Map<string, Date>();
    for (const row of rows) {
      try {
        // Multi-location (ADR-0018): accept webhooks for any active sync target,
        // not just a single env-configured merchant.
        if (!(await this.syncTargets.isActive(row.merchant_id))) {
          await this.markIgnored(row.id, `Merchant ${row.merchant_id} is not an active sync target.`);
          continue;
        }

        if (!isSupportedObjectType(row.object_type)) {
          await this.markIgnored(row.id, `Unsupported Clover webhook object type: ${row.object_type}.`);
          continue;
        }

        await enqueueForUpdate(this.jobs, this.config, mapInboxRow(row));
        if (row.object_type === "O" || row.object_type === "P") {
          const eventTs = row.event_ts ?? new Date();
          const current = miniSweepCandidates.get(row.merchant_id);
          if (!current || eventTs < current) {
            miniSweepCandidates.set(row.merchant_id, eventTs);
          }
        }
        await this.markProcessed(row.id);
      } catch (error) {
        await this.markProcessingFailure(row, error);
      }
    }
    await this.createMiniSweepsIfNeeded(miniSweepCandidates);
  }

  private async markProcessed(id: string) {
    await this.pool.query(
      `
        UPDATE audit.webhook_inbox
        SET status = 'processed',
            processed_at = now(),
            locked_at = null,
            locked_by = null,
            error_message = null
        WHERE id = $1
      `,
      [id]
    );
  }

  private async markIgnored(id: string, reason: string) {
    await this.pool.query(
      `
        UPDATE audit.webhook_inbox
        SET status = 'ignored',
            processed_at = now(),
            locked_at = null,
            locked_by = null,
            error_message = $2
        WHERE id = $1
      `,
      [id, reason]
    );
  }

  private async markProcessingFailure(row: WebhookInboxRow, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (row.attempt_count >= row.max_attempts) {
      await this.markFailed(row.id, message);
      return;
    }

    const delaySeconds = Math.min(3600, 2 ** Math.max(0, row.attempt_count - 1) * 30);
    await this.pool.query(
      `
        UPDATE audit.webhook_inbox
        SET status = 'pending',
            run_after = now() + ($2::text)::interval,
            locked_at = null,
            locked_by = null,
            error_message = $3
        WHERE id = $1
      `,
      [row.id, `${delaySeconds} seconds`, message]
    );
  }

  private async markFailed(id: string, message: string) {
    await this.pool.query(
      `
        UPDATE audit.webhook_inbox
        SET status = 'failed',
            locked_at = null,
            locked_by = null,
            error_message = $2
        WHERE id = $1
      `,
      [id, message]
    );
  }

  private async createMiniSweepsIfNeeded(candidates: Map<string, Date>) {
    for (const [merchantId, earliestEventTs] of candidates) {
      const pending = await this.jobs.pendingWebhookFetchCount(merchantId);
      if (pending < this.config.webhookMiniSweepBacklogThreshold) {
        continue;
      }

      await this.jobs.cancelPendingWebhookFetches(merchantId);
      const start = new Date(earliestEventTs.getTime() - 5 * 60_000);
      const end = new Date();
      await this.jobs.enqueue({
        jobType: "mini_rest_sweep",
        merchantId,
        dedupeKey: `${merchantId}:mini_rest_sweep:${end.toISOString().slice(0, 16)}`,
        windowStart: start,
        windowEnd: end,
        payload: {
          start: start.toISOString(),
          end: end.toISOString(),
          reason: "webhook_backlog"
        },
        priority: 10
      });
    }
  }
}

export function isSupportedObjectType(objectType: string) {
  return objectType === "O" || objectType === "P" || objectType === "E";
}

function mapInboxRow(row: WebhookInboxRow): ParsedUpdate {
  return {
    merchantId: row.merchant_id,
    objectId: row.object_id,
    objectType: row.object_type,
    eventType: row.event_type,
    eventTs: row.event_ts ?? undefined,
    raw: row.raw_event,
    dedupeKey: row.dedupe_key
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
