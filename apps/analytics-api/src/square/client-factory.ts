import type { AppConfig } from "../config.js";
import type { SyncTargetsReader } from "../sync-targets/repository.js";
import { SquareClient, defaultVendorFactory, type SquareVendorFactory } from "./client.js";

const SQUARE_MERCHANT_PREFIX = "square:";

// The analytics merchant_id for a Square store is the synthetic PosStore id
// `square:{location_id}`; the bare location id is what Square's API filters on.
export function squareLocationIdFromMerchantId(merchantId: string): string {
  return merchantId.startsWith(SQUARE_MERCHANT_PREFIX)
    ? merchantId.slice(SQUARE_MERCHANT_PREFIX.length)
    : merchantId;
}

/**
 * Resolves a per-store `SquareClient` (multi-location, ADR-0018) — the Square
 * sibling of CloverClientFactory. `get(merchantId)` reads the store's token from
 * config.sync_targets (Iron Law 1: the token arrived via the push handoff, not a
 * db-kds import), parses the location id, and caches the client per merchant,
 * rebuilding on token rotation. The environment is per-deploy (config), since
 * there is one Square store today.
 */
export class SquareClientFactory {
  private readonly cache = new Map<string, { token: string; client: SquareClient }>();

  constructor(
    private readonly config: AppConfig,
    private readonly syncTargets: SyncTargetsReader,
    private readonly vendorFactory: SquareVendorFactory = defaultVendorFactory
  ) {}

  async get(merchantId: string): Promise<SquareClient> {
    const target = await this.syncTargets.get(merchantId);
    if (!target) {
      throw new Error(`No active sync target for merchant ${merchantId}; cannot build Square client.`);
    }
    if (target.provider !== "square") {
      throw new Error(`Sync target ${merchantId} is not a Square store (provider=${target.provider}).`);
    }
    const cached = this.cache.get(merchantId);
    if (cached && cached.token === target.token) {
      return cached.client;
    }
    const vendor = this.vendorFactory(target.token, this.config.squareEnvironment);
    const client = new SquareClient(squareLocationIdFromMerchantId(merchantId), vendor);
    this.cache.set(merchantId, { token: target.token, client });
    return client;
  }
}
