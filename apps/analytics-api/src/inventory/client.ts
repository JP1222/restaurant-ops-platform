import {
  ActualCogsInputsResponseSchema,
  LaborCostsResponseSchema,
  PlateCostsResponseSchema,
  type ActualCogsInputsResponse,
  type LaborCostsResponse,
  type PlateCostsResponse
} from "@rop/contracts";

import type { AppConfig } from "../config.js";

/**
 * Fetch plate costs from inventory-api (ADR-0031). Read-only HTTP — Iron Laws
 * 1 + 5: analytics reads an external source, never inventory's DB. The response
 * is validated against the shared contract before it reaches the mart.
 */
export async function fetchPlateCosts(config: AppConfig): Promise<PlateCostsResponse> {
  const url = `${config.inventoryApiBaseUrl}/api/recipes/plate-costs`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    throw new Error(`inventory plate-costs fetch failed: HTTP ${res.status}`);
  }
  return PlateCostsResponseSchema.parse(await res.json());
}

/**
 * Fetch labor costs from inventory-api (ADR-0033, Phase 4b). Same read-only HTTP
 * contract as plate cost: analytics reads an external write-source and writes only
 * its own mart (Iron Laws 1 + 5). Snapshots arrive already stamped with the store's
 * merchant id; validated against the shared contract before they reach the mart.
 */
export async function fetchLaborCosts(config: AppConfig): Promise<LaborCostsResponse> {
  const url = `${config.inventoryApiBaseUrl}/api/labor-costs`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    throw new Error(`inventory labor-costs fetch failed: HTTP ${res.status}`);
  }
  return LaborCostsResponseSchema.parse(await res.json());
}

/**
 * Fetch count-based actual-COGS windows from inventory-api (ADR-0031, yield-variance
 * lens). Same read-only HTTP contract as plate / labor cost: analytics reads an external
 * write-source and writes only its own mart (Iron Laws 1 + 5). Windows arrive already
 * stamped with the store's merchant id; validated against the shared contract first.
 */
export async function fetchActualCogs(config: AppConfig): Promise<ActualCogsInputsResponse> {
  const url = `${config.inventoryApiBaseUrl}/api/actual-cogs-inputs`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    throw new Error(`inventory actual-cogs fetch failed: HTTP ${res.status}`);
  }
  return ActualCogsInputsResponseSchema.parse(await res.json());
}
