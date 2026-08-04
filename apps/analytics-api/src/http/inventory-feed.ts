import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppConfig } from "../config.js";
import type { DbPool } from "../db.js";
import { isAdminAuthorized } from "./admin.js";
import { respondJson } from "./health.js";

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1000;
const EPOCH = "1970-01-01T00:00:00.000Z";

// Sold line-items feed for inventory-api's sales-driven depletion poll (ADR-0028,
// Iron Law 5: inventory reads this read-only OLAP mart over HTTP, never its DB).
// Returns finished-good line items sold at-or-after `since`, ordered by sale time.
//
// The watermark is INCLUSIVE (created_at_utc >= since): `created_at_utc` is not
// unique, and analytics ingests asynchronously (webhooks + backfill), so an
// exclusive cursor could skip a boundary or late-arriving row. The consumer dedups
// by line_item_id (its movement ledger is idempotent), so re-emitting the boundary
// is harmless. Refunded lines are excluded — they never depleted stock.
// `item_id` is the Clover item id, the depletion join key. Each row also carries
// `modifiers` (the selected modifier display names from mart.fact_line_item_modifiers,
// always present, [] when none) so inventory-api can do modifier-level depletion.
export async function handleInventorySoldItems(
  req: IncomingMessage,
  res: ServerResponse,
  pool: DbPool,
  config: AppConfig,
  url: URL
) {
  if (!isAdminAuthorized(req, config)) {
    return respondJson(res, 401, { error: "unauthorized" });
  }

  const merchantId = url.searchParams.get("merchantId");
  if (!merchantId || merchantId.length > 64) {
    return respondJson(res, 400, { error: "missing_merchant_id" });
  }

  const since = url.searchParams.get("since") || EPOCH;
  if (Number.isNaN(Date.parse(since))) {
    return respondJson(res, 400, { error: "invalid_since" });
  }

  const limitRaw = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(limitRaw, 1), MAX_LIMIT)
    : DEFAULT_LIMIT;

  const result = await pool.query<{
    line_item_id: string;
    item_id: string | null;
    item_name: string | null;
    quantity: string | number;
    created_at_utc: Date;
    modifier_names: string[] | null;
  }>(
    `
      SELECT li.line_item_id, li.item_id, li.item_name, li.quantity, li.created_at_utc,
             COALESCE(
               (SELECT array_agg(m.modifier_name ORDER BY m.modifier_name)
                FROM mart.fact_line_item_modifiers m
                WHERE m.line_item_id = li.line_item_id
                  AND m.merchant_id = li.merchant_id),
               ARRAY[]::text[]
             ) AS modifier_names
      FROM mart.fact_order_line_items li
      WHERE li.merchant_id = $1
        AND li.refunded = false
        AND li.created_at_utc >= $2
      ORDER BY li.created_at_utc ASC
      LIMIT $3
    `,
    [merchantId, since, limit]
  );

  // fact_order_line_items.item_id holds the provider's catalog id (the Clover item
  // id, or the Square catalog_object_id for a `square:{loc}` store). Route it to the
  // matching contract field so inventory-api joins its recipe BOM by the right key.
  const isSquare = merchantId.startsWith("square:");

  const items = result.rows.map((row) => ({
    line_item_id: row.line_item_id,
    clover_item_id: isSquare ? null : row.item_id,
    square_catalog_item_id: isSquare ? row.item_id : null,
    item_name: row.item_name ?? "",
    quantity: Number(row.quantity),
    // Modifier display names selected on this line, used by inventory-api for
    // modifier-level depletion (it matches each name against recipe option names).
    // Defensively drop nulls/blanks; absent modifiers yield [].
    modifiers: (row.modifier_names ?? []).filter(
      (name): name is string => typeof name === "string" && name.length > 0
    )
  }));

  // Advance the cursor to the last (newest) row's sale time, or hold at `since`
  // when the page is empty. Rows are ASC, so the tail carries the max timestamp.
  const cursor =
    result.rows.length > 0
      ? result.rows[result.rows.length - 1]!.created_at_utc.toISOString()
      : since;

  return respondJson(res, 200, { items, cursor });
}
