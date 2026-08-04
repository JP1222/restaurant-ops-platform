import { randomUUID } from "node:crypto";
import type { DbPool } from "../db.js";
import { createLogger, errorMessage } from "../lib/log.js";
import type { JsonRecord } from "../types.js";

const log = createLogger("scheduler.heartbeat");

export class Heartbeat {
  private readonly instanceId: string;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly pool: DbPool,
    private readonly component: string,
    private readonly details: JsonRecord = {},
    private readonly intervalMs = 30_000
  ) {
    this.instanceId = `${component}-${process.pid}-${randomUUID()}`;
  }

  start() {
    this.stopped = false;
    void this.write();
    this.timer = setInterval(() => void this.write(), this.intervalMs);
    this.timer.unref();
  }

  stop() {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async write() {
    if (this.stopped) {
      return;
    }
    try {
      await writeHeartbeat(this.pool, this.component, this.instanceId, this.details);
    } catch (error) {
      log.error(`Heartbeat failed for ${this.component}: ${errorMessage(error)}`, { component: this.component });
    }
  }

  id() {
    return this.instanceId;
  }
}

export async function writeHeartbeat(
  pool: DbPool,
  component: string,
  instanceId: string,
  details: JsonRecord = {}
) {
  await pool.query(
    `
      INSERT INTO audit.service_heartbeats (component, instance_id, last_seen_at, details)
      VALUES ($1, $2, now(), $3::jsonb)
      ON CONFLICT (component) DO UPDATE SET
        instance_id = EXCLUDED.instance_id,
        last_seen_at = now(),
        details = EXCLUDED.details
    `,
    [component, instanceId, JSON.stringify(details)]
  );
}
