import { withTransaction, type DbPool } from "../db.js";

/**
 * Governed metric registry (ADR-0030, Phase 0b).
 *
 * A metric is a dev-authored definition stored in `meta.metric_definitions`
 * (seeded by migration 010). The composer turns `(name, dimensions, window,
 * filters)` into a single deterministic, parameterized SQL query — the AI never
 * authors SQL for an authoritative number; it asks for a metric BY NAME and the
 * dimensions/filters it wants from an allow-list.
 *
 * Safety model: `measure`, `base_view`, and the allowed dimension/filter
 * IDENTIFIERS come from the registry (dev-authored) and are interpolated; every
 * CALLER-supplied value (merchant id, dates, day count, filter values) is bound
 * as a `$n` parameter. A requested dimension/filter is only ever interpolated
 * after an exact-match check against the metric's allow-list, so no
 * caller-controlled identifier can reach the SQL string.
 */

export type MetricUnit = "cents" | "count" | "ratio";
export type MetricFormat = "currency" | "number" | "percent";

export interface MetricDefinition {
  name: string;
  label: string;
  /** SQL aggregate expression evaluated over `baseView` (dev-authored). */
  measure: string;
  /** The only relation the composer reads, e.g. `mart.sales_daily_mv`. */
  baseView: string;
  allowedDimensions: string[];
  allowedFilters: string[];
  unit: MetricUnit;
  format: MetricFormat;
  synonyms: string[];
  /** Prose business definition, surfaced to the operator for trust. */
  definition: string;
}

export type MetricWindow =
  | { mode: "days"; days: number }
  | { mode: "range"; from: string; to: string };

export interface ResolveMetricOptions {
  merchantId: string;
  timezone: string;
  window: MetricWindow;
  dimensions?: string[];
  filters?: Record<string, string>;
}

export interface ComposedQuery {
  text: string;
  values: unknown[];
}

export interface MetricResult {
  rows: Record<string, unknown>[];
  sql: string;
  definition: string;
  unit: MetricUnit;
}

export type MetricRegistry = Map<string, MetricDefinition>;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Pure (no I/O): compose the parameterized SQL for a metric + options.
 * Throws on any dimension/filter outside the metric's allow-list or a malformed
 * window — the same fail-loud-not-silently posture as the safe-query guard.
 */
export function composeMetricSql(def: MetricDefinition, opts: ResolveMetricOptions): ComposedQuery {
  const dimensions = opts.dimensions ?? [];
  for (const dimension of dimensions) {
    if (!def.allowedDimensions.includes(dimension)) {
      throw new Error(`metric "${def.name}" does not allow dimension "${dimension}"`);
    }
  }

  const filters = opts.filters ?? {};
  for (const key of Object.keys(filters)) {
    if (!def.allowedFilters.includes(key)) {
      throw new Error(`metric "${def.name}" does not allow filter "${key}"`);
    }
  }

  const values: unknown[] = [];
  const bind = (value: unknown): string => `$${values.push(value)}`;

  const where: string[] = [`merchant_id = ${bind(opts.merchantId)}`];
  let cte = "";
  let from = def.baseView;

  if (opts.window.mode === "range") {
    if (!ISO_DATE_RE.test(opts.window.from) || !ISO_DATE_RE.test(opts.window.to)) {
      throw new Error("range window requires ISO dates (YYYY-MM-DD)");
    }
    where.push(`business_date BETWEEN ${bind(opts.window.from)}::date AND ${bind(opts.window.to)}::date`);
  } else {
    if (!Number.isInteger(opts.window.days) || opts.window.days < 1) {
      throw new Error("days window requires a positive integer");
    }
    // Timezone-aware "today" bounds, mirroring the salesSummary handler.
    cte = `WITH bounds AS (SELECT (now() AT TIME ZONE ${bind(opts.timezone)})::date AS today)\n`;
    from = `${def.baseView}, bounds`;
    where.push(`business_date >= bounds.today - (${bind(opts.window.days)}::integer - 1)`);
  }

  for (const [key, value] of Object.entries(filters)) {
    where.push(`${key} = ${bind(value)}`);
  }

  const selectList = [...dimensions, `${def.measure} AS value`].join(", ");
  const groupOrder = dimensions.length
    ? `\nGROUP BY ${dimensions.join(", ")}\nORDER BY ${dimensions.join(", ")}`
    : "";

  const text = `${cte}SELECT ${selectList}\nFROM ${from}\nWHERE ${where.join("\n  AND ")}${groupOrder}`;
  return { text, values };
}

/**
 * Resolve a metric to rows. Executes the composed query in a READ ONLY
 * transaction with a statement timeout and the mart/meta search path — the same
 * execution guards as the free-SQL sandbox, minus the AI audit log (callers on
 * the AI path log to audit.ai_query_log themselves).
 */
export async function resolveMetric(
  pool: DbPool,
  registry: MetricRegistry,
  name: string,
  opts: ResolveMetricOptions,
  statementTimeoutMs = 30_000,
): Promise<MetricResult> {
  const def = registry.get(name);
  if (!def) {
    throw new Error(`unknown metric "${name}"`);
  }

  const { text, values } = composeMetricSql(def, opts);
  const rows = await withTransaction(pool, async (client) => {
    await client.query("SET TRANSACTION READ ONLY");
    await client.query("SET LOCAL search_path = mart, meta, public");
    await client.query(`SET LOCAL statement_timeout = ${Math.trunc(statementTimeoutMs)}`);
    const result = await client.query(text, values);
    return result.rows as Record<string, unknown>[];
  });

  return { rows, sql: text, definition: def.definition, unit: def.unit };
}

interface MetricRow {
  metric_name: string;
  label: string | null;
  measure: string | null;
  base_view: string | null;
  allowed_dimensions: string[] | null;
  allowed_filters: string[] | null;
  unit: string | null;
  format: string | null;
  synonyms: string[] | null;
  business_definition: string;
}

/** Load every executable metric (measure + base_view set) from the registry table. */
export async function loadMetricRegistry(pool: DbPool): Promise<MetricRegistry> {
  const result = await pool.query<MetricRow>(`
    SELECT metric_name, label, measure, base_view, allowed_dimensions, allowed_filters,
           unit, format, synonyms, business_definition
    FROM meta.metric_definitions
    WHERE measure IS NOT NULL AND base_view IS NOT NULL
  `);

  const registry: MetricRegistry = new Map();
  for (const row of result.rows) {
    if (!row.measure || !row.base_view) {
      continue;
    }
    registry.set(row.metric_name, {
      name: row.metric_name,
      label: row.label ?? row.metric_name,
      measure: row.measure,
      baseView: row.base_view,
      allowedDimensions: row.allowed_dimensions ?? [],
      allowedFilters: row.allowed_filters ?? [],
      unit: (row.unit as MetricUnit | null) ?? "count",
      format: (row.format as MetricFormat | null) ?? "number",
      synonyms: row.synonyms ?? [],
      definition: row.business_definition,
    });
  }
  return registry;
}
