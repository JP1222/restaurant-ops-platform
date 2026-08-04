import { InventorySoldItemsFeedSchema } from "@rop/contracts";

import type { SoldItemsFetcher, SoldItemsPage } from "./inventory-store.js";

// GH #468: a wrong/stale ANALYTICS_ADMIN_TOKEN makes analytics-api answer the
// sold-items feed with 401/403. Without a distinct error type that surfaced as a
// generic 500 on the manual "Sync sales" click, giving the operator no hint that
// the token is the problem. The sync-sales route catches this and returns a
// clear 502 instead.
export class AnalyticsFeedAuthError extends Error {
  constructor(readonly status: number) {
    super(`analytics sold-items auth rejected (${status}) — check ANALYTICS_ADMIN_TOKEN`);
    this.name = "AnalyticsFeedAuthError";
  }
}

export interface AnalyticsFeedConfig {
  baseUrl: string;
  token: string;
  merchantId: string;
  limit?: number;
}

// Build a SoldItemsFetcher backed by analytics-api's read-only sold-items feed
// (ADR-0028, Iron Law 5: inventory reads the OLAP mart over HTTP, never its DB).
// This is the real implementation of the injection point runDepletionPoll was
// built around. The response is validated against the shared contract on receipt
// (Iron Law 2 trust boundary), then mapped from the snake_case feed rows to the
// worker's SoldMenuItem shape. `cursor` is passed straight through as the `since`
// watermark; the feed's returned cursor becomes the next watermark.
export function buildAnalyticsSoldItemsFetcher(config: AnalyticsFeedConfig): SoldItemsFetcher {
  return async (cursor: string | null): Promise<SoldItemsPage> => {
    const url = new URL("/admin/api/inventory/sold-items", config.baseUrl);
    url.searchParams.set("merchantId", config.merchantId);
    url.searchParams.set("limit", String(config.limit ?? 500));
    if (cursor) {
      url.searchParams.set("since", cursor);
    }

    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${config.token}`
      },
      // Bound the cross-service call so a hung/slow analytics-api can't exhaust
      // the inventory-api request pool — sync-sales awaits this synchronously and
      // Fastify has no requestTimeout. Mirrors analytics-api's own fetchPlateCosts.
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      // 401/403 = the bearer token was rejected. Throw a typed error so the
      // sync-sales route can map it to a clear "check the token" message (#468).
      if (response.status === 401 || response.status === 403) {
        throw new AnalyticsFeedAuthError(response.status);
      }
      throw new Error(`analytics sold-items ${response.status}: ${body.slice(0, 200)}`);
    }

    const feed = InventorySoldItemsFeedSchema.parse(await response.json());
    return {
      soldItems: feed.items.map((item) => ({
        lineItemId: item.line_item_id,
        itemName: item.item_name,
        quantity: item.quantity,
        // Modifier names selected on this line (ADR-0028 modifier depletion); the
        // contract defaults this to [] so a pre-modifier feed still maps cleanly.
        modifierNames: item.modifiers,
        // Provider catalog id — exactly one is non-null per the store's provider
        // (#790). Conditionally omit (not set to undefined): SoldMenuItem's id fields
        // are exact-optional properties, so an explicit undefined would be rejected.
        ...(item.clover_item_id ? { cloverItemId: item.clover_item_id } : {}),
        ...(item.square_catalog_item_id
          ? { squareCatalogObjectId: item.square_catalog_item_id }
          : {})
      })),
      nextCursor: feed.cursor
    };
  };
}
