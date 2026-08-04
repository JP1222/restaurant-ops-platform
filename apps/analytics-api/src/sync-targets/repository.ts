import type { AppConfig } from "../config.js";
import type { DbPool } from "../db.js";
import { createLogger } from "../lib/log.js";

const log = createLogger("sync-targets");

// A store analytics should sync. `provider` is forward-compat (ADR-0019); only
// 'clover' is ingested today. The store list lives in analytics' own DB
// (`config.sync_targets`) because Iron Law 1 forbids importing db-kds.
export interface SyncTarget {
  merchantId: string;
  provider: string;
  token: string;
  storeTimezone: string;
  active: boolean;
}

export interface SyncTargetInput {
  merchantId: string;
  token: string;
  provider?: string;
  storeTimezone?: string;
  active?: boolean;
}

interface SyncTargetRow {
  merchant_id: string;
  provider: string;
  token: string;
  store_timezone: string;
  active: boolean;
}

function fromRow(row: SyncTargetRow): SyncTarget {
  return {
    merchantId: row.merchant_id,
    provider: row.provider,
    token: row.token,
    storeTimezone: row.store_timezone,
    active: row.active
  };
}

const CACHE_TTL_MS = 30_000;

// Read-only view consumers depend on (Scheduler, the JobRunner client factory,
// mart-refresh, webhook-inbox, dashboard). Depending on this interface lets
// tests inject a lightweight fake without a DB; the concrete repository below
// adds the write helpers (upsert, seedFromEnvIfEmpty) used by the admin
// endpoint and service bootstrap.
export interface SyncTargetsReader {
  loadActive(force?: boolean): Promise<SyncTarget[]>;
  get(merchantId: string): Promise<SyncTarget | null>;
  isActive(merchantId: string): Promise<boolean>;
  timezoneFor(merchantId: string, fallback: string): Promise<string>;
}

/**
 * Source of truth for which stores analytics syncs. Reads are cached with a
 * short TTL because two hot paths hit it (scheduler each tick, mart-refresh
 * timezone lookups); `upsert()` invalidates so a newly-registered store is
 * picked up promptly without a restart.
 */
export class SyncTargetsRepository implements SyncTargetsReader {
  private cache: { at: number; targets: SyncTarget[] } | null = null;

  constructor(private readonly pool: DbPool) {}

  invalidate(): void {
    this.cache = null;
  }

  private async loadAll(force = false): Promise<SyncTarget[]> {
    const now = Date.now();
    if (!force && this.cache && now - this.cache.at < CACHE_TTL_MS) {
      return this.cache.targets;
    }
    const result = await this.pool.query<SyncTargetRow>(
      "SELECT merchant_id, provider, token, store_timezone, active FROM config.sync_targets"
    );
    const targets = result.rows.map(fromRow);
    this.cache = { at: now, targets };
    return targets;
  }

  async loadActive(force = false): Promise<SyncTarget[]> {
    return (await this.loadAll(force)).filter((target) => target.active);
  }

  async get(merchantId: string): Promise<SyncTarget | null> {
    return (await this.loadAll()).find((target) => target.merchantId === merchantId) ?? null;
  }

  async isActive(merchantId: string): Promise<boolean> {
    return (await this.get(merchantId))?.active === true;
  }

  async timezoneFor(merchantId: string, fallback: string): Promise<string> {
    return (await this.get(merchantId))?.storeTimezone ?? fallback;
  }

  async upsert(input: SyncTargetInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO config.sync_targets (merchant_id, provider, token, store_timezone, active, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (merchant_id) DO UPDATE SET
         provider = EXCLUDED.provider,
         token = EXCLUDED.token,
         store_timezone = EXCLUDED.store_timezone,
         active = EXCLUDED.active,
         updated_at = now()`,
      [
        input.merchantId,
        input.provider ?? "clover",
        input.token,
        input.storeTimezone ?? "America/Chicago",
        input.active ?? true
      ]
    );
    this.invalidate();
  }

  // Bootstrap fallback: if the table is empty and single-merchant env vars are
  // set, seed one active target so existing single-store deploys keep working
  // with no config change.
  async seedFromEnvIfEmpty(config: AppConfig): Promise<void> {
    if (!config.cloverMerchantId || !config.cloverToken) {
      return;
    }
    const existing = await this.pool.query("SELECT 1 FROM config.sync_targets LIMIT 1");
    if (existing.rowCount && existing.rowCount > 0) {
      return;
    }
    await this.upsert({
      merchantId: config.cloverMerchantId,
      provider: "clover",
      token: config.cloverToken,
      storeTimezone: config.storeTimezone,
      active: true
    });
    log.info(`Seeded config.sync_targets from env (merchant ${config.cloverMerchantId}).`, {
      merchantId: config.cloverMerchantId
    });
  }
}
