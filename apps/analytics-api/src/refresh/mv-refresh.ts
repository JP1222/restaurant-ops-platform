import type { AppConfig } from "../config.js";
import type { DbPool } from "../db.js";
import { withTransaction } from "../db.js";
import { advisoryKey, AdvisoryNamespace, withSessionAdvisoryLock } from "../scheduler/advisory-lock.js";

const MATERIALIZED_VIEWS = [
  "mart.sales_daily_mv",
  // cost_daily_mv reads sales_daily_mv, so it must refresh AFTER it in this
  // batch (same transaction -> sees the just-refreshed net sales).
  "mart.cost_daily_mv",
  // prime_cost_daily_mv reads cost_daily_mv, so it refreshes AFTER the food leg
  // (same transaction -> sees the just-refreshed COGS + net sales).
  "mart.prime_cost_daily_mv",
  // cost_variance_daily_mv reads cost_daily_mv (theoretical leg) + dim_actual_cogs,
  // so it refreshes AFTER cost_daily_mv to see the just-refreshed theoretical COGS.
  "mart.cost_variance_daily_mv",
  "mart.sales_hourly_mv",
  "mart.item_sales_daily_mv",
  "mart.payment_method_daily_mv",
  "mart.employee_sales_daily_mv",
  "mart.item_sales_hourly_mv"
];

const MV_REFRESH_LOCK_KEY = advisoryKey("mv-refresh:batch");
const MAX_BATCH_ATTEMPTS = 2;

export async function refreshMaterializedViewsThrottled(pool: DbPool, config: AppConfig) {
  // GH #482: the throttle window must be advanced ONLY after a refresh actually
  // succeeds. The old code bumped updated_at=now() in this gate query (which
  // auto-commits) BEFORE running the REFRESH, so a failed refresh masked itself
  // for one throttle window — the next tick saw should_refresh=false and served
  // stale (and worse, fresh-sales/stale-cost) aggregates.
  //
  // So this query only READS staleness; the `SET updated_at = audit.refresh_state.updated_at`
  // is a deliberate self-assignment no-op (it does NOT advance) that exists so
  // the ON CONFLICT path still RETURNs the gate. First-ever run inserts 'epoch'
  // → stale → refreshes. The throttle is advanced below, only on success.
  const result = await pool.query<{ should_refresh: boolean }>(
    `
      INSERT INTO audit.refresh_state (key, updated_at, payload)
      VALUES ('materialized_views', 'epoch', '{}'::jsonb)
      ON CONFLICT (key) DO UPDATE SET
        updated_at = audit.refresh_state.updated_at
      RETURNING updated_at <= now() - ($1::text)::interval AS should_refresh
    `,
    [`${config.martMvRefreshMinIntervalSeconds} seconds`]
  );

  if (!result.rows[0]?.should_refresh) {
    return false;
  }

  // A throw here (persistent refresh failure) propagates WITHOUT advancing the
  // throttle, so the next tick retries instead of skipping. `refreshed` is false
  // only when another session already held the advisory lock — that worker will
  // advance the throttle on its own success, so we must not advance here either.
  const refreshed = await refreshMaterializedViews(pool);
  if (refreshed) {
    await pool.query(
      `UPDATE audit.refresh_state SET updated_at = now() WHERE key = 'materialized_views'`
    );
  }
  return refreshed;
}

/**
 * Refresh every materialized view in `MATERIALIZED_VIEWS` as a single atomic
 * batch. If any view fails mid-batch the whole batch rolls back and we retry
 * once; a second failure surfaces the error to the caller.
 *
 * Atomicity matters: `mart.sales_daily_mv` and `mart.sales_hourly_mv` must
 * agree, otherwise the dashboard shows daily totals that don't roll up from
 * hourly buckets (issue #149).
 *
 * `REFRESH MATERIALIZED VIEW CONCURRENTLY` cannot run inside a transaction in
 * Postgres, so we trade concurrency for atomicity here: each REFRESH inside
 * the BEGIN/COMMIT takes a brief AccessExclusiveLock on the MV. Acceptable
 * because analytics-api throttles MV refresh (`martMvRefreshMinIntervalSeconds`)
 * and reader queries already tolerate transient blocking.
 *
 * A session-level advisory lock serializes refreshers so two workers can't
 * pile competing transactions on the same MVs.
 */
export async function refreshMaterializedViews(pool: DbPool) {
  const ran = await withSessionAdvisoryLock(
    pool,
    AdvisoryNamespace.MartRefresh,
    MV_REFRESH_LOCK_KEY,
    async () => {
      let lastError: unknown;
      for (let attempt = 1; attempt <= MAX_BATCH_ATTEMPTS; attempt += 1) {
        try {
          await withTransaction(pool, async (client) => {
            for (const view of MATERIALIZED_VIEWS) {
              await client.query(`REFRESH MATERIALIZED VIEW ${view}`);
            }
          });
          return true;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError;
    }
  );
  // `withSessionAdvisoryLock` returns null when another session holds the
  // lock — that's fine, another worker is already refreshing.
  return ran === true;
}
