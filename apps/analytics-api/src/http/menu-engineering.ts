import type { DbPool } from "../db.js";

export interface MenuEngineeringItem {
  /** Clover item id (the cost join key); null when the item has no Clover link. */
  clover_item_id: string | null;
  item_fingerprint: string;
  item_name: string;
  units: number;
  gross_sales_cents: number;
  /** Per-unit plate cost from mart.dim_item_cost; null = cost unknown (no recipe). */
  plate_cost_cents: number | null;
}

export interface MenuEngineeringResponse {
  days: number;
  items: MenuEngineeringItem[];
}

/**
 * Per-item inputs for the Kasavana-Smith menu-engineering matrix (ADR-0031):
 * units + revenue from sales, joined to the latest plate cost. The quadrant
 * classification (and its operator-tunable popularity factor) is computed by the
 * page from these inputs, so this endpoint stays a plain read.
 *
 * Join: item_sales_daily_mv (per item_fingerprint) -> dim_item (fingerprint ->
 * Clover item_id) -> latest dim_item_cost (item_id = clover_item_id). Items with
 * no Clover link or no cost row get `plate_cost_cents: null` ("cost unknown") —
 * never $0, which would falsely mark a high-price item a Star (invariant #6).
 */
export async function menuEngineering(
  pool: DbPool,
  merchantId: string,
  timezone: string,
  days: number,
): Promise<MenuEngineeringResponse> {
  const result = await pool.query<{
    clover_item_id: string | null;
    item_fingerprint: string;
    item_name: string;
    units: string;
    gross_sales_cents: string;
    plate_cost_cents: string | null;
  }>(
    `
      WITH latest_cost AS (
        SELECT DISTINCT ON (clover_item_id) clover_item_id, plate_cost_cents
        FROM mart.dim_item_cost
        ORDER BY clover_item_id, effective_from DESC
      )
      SELECT
        di.item_id AS clover_item_id,
        i.item_fingerprint,
        max(i.item_name) AS item_name,
        sum(i.quantity)::float8 AS units,
        sum(i.gross_sales_cents)::bigint AS gross_sales_cents,
        lc.plate_cost_cents AS plate_cost_cents
      FROM mart.item_sales_daily_mv i
      LEFT JOIN mart.dim_item di
        ON di.merchant_id = i.merchant_id AND di.item_fingerprint = i.item_fingerprint
      LEFT JOIN latest_cost lc ON lc.clover_item_id = di.item_id
      WHERE i.merchant_id = $1
        AND i.business_date >= (now() AT TIME ZONE $2)::date - ($3::integer - 1)
      GROUP BY di.item_id, i.item_fingerprint, lc.plate_cost_cents
      ORDER BY units DESC
    `,
    [merchantId, timezone, days],
  );

  const items: MenuEngineeringItem[] = result.rows.map((row) => ({
    clover_item_id: row.clover_item_id,
    item_fingerprint: row.item_fingerprint,
    item_name: row.item_name,
    units: Number(row.units),
    gross_sales_cents: Number(row.gross_sales_cents),
    plate_cost_cents: row.plate_cost_cents === null ? null : Number(row.plate_cost_cents),
  }));

  return { days, items };
}
