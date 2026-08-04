import type { AppConfig } from "../config.js";
import type { SyncTargetsReader } from "../sync-targets/repository.js";
import { CloverClient } from "./client.js";

/**
 * Resolves a per-store `CloverClient` (multi-location, ADR-0018). `JobRunner`
 * calls `get(job.merchantId)` so each job talks to Clover with the right store's
 * token. Clients are cached per merchant (keeping the per-client rate limiter)
 * and rebuilt when the stored token changes (rotation).
 */
export class CloverClientFactory {
  private readonly cache = new Map<string, { token: string; client: CloverClient }>();

  constructor(
    private readonly config: AppConfig,
    private readonly syncTargets: SyncTargetsReader
  ) {}

  async get(merchantId: string): Promise<CloverClient> {
    const target = await this.syncTargets.get(merchantId);
    if (!target) {
      throw new Error(`No active sync target for merchant ${merchantId}; cannot build Clover client.`);
    }
    const cached = this.cache.get(merchantId);
    if (cached && cached.token === target.token) {
      return cached.client;
    }
    const client = new CloverClient(this.config, merchantId, target.token);
    this.cache.set(merchantId, { token: target.token, client });
    return client;
  }
}
