export interface HealthzResponse {
  ok: boolean;
}

type JsonObject = Record<string, unknown>;
type CountValue = number | string;
type IsoDateTime = string | null;

export interface DailySalesRow {
  business_date: string;
  order_count: number | string;
  payment_total_cents: number | string;
  refund_total_cents: number | string;
  net_sales_cents: number | string;
  tax_total_cents: number | string;
  tip_total_cents: number | string;
  discount_total_cents: number | string;
  /**
   * Resolved per business_date through the governed metric registry (ADR-0030)
   * by analytics-api `salesSummary`: `avg_ticket_cents` = net_sales / order_count;
   * `refund_rate` = refund_total / payment_total (registry 口径, differs from the
   * legacy refund_total / net_sales). Optional so fixtures predating the Phase-0
   * migration still typecheck; `null` when the day has no resolvable value.
   */
  avg_ticket_cents?: number | null;
  refund_rate?: number | null;
}

export interface SalesTotals {
  today_net_sales_cents?: number | string;
  today_order_count?: number | string;
  last_7_net_sales_cents?: number | string;
  last_7_order_count?: number | string;
  last_30_net_sales_cents?: number | string;
  last_30_order_count?: number | string;
  range_payment_total_cents?: number | string;
  range_refund_total_cents?: number | string;
  range_tax_total_cents?: number | string;
  range_tip_total_cents?: number | string;
}

export interface SalesResponse {
  days?: number;
  from?: string;
  to?: string;
  daily: DailySalesRow[];
  totals: SalesTotals;
}

export interface HourlyRow {
  business_date: string;
  hour: number | string;
  net_sales_cents: number | string;
  order_count: number | string;
  payment_total_cents: number | string;
}

export type HourlyResponse = HourlyRow[];

export interface TopItemRow {
  item_fingerprint: string;
  item_name: string;
  alternate_name: string | null;
  quantity: number | string;
  gross_sales_cents: number | string;
  modifier_total_cents: number | string;
  line_count: number | string;
  modifier_line_count: number | string;
}

export interface ItemsResponse {
  days: number;
  items: TopItemRow[];
}

/**
 * Raw per-item inputs for the Kasavana-Smith menu-engineering matrix
 * (analytics-api GET /admin/api/menu-engineering, ADR-0031). Units + realized
 * revenue joined to the latest plate cost. `plate_cost_cents: null` means
 * "cost unknown" (no recipe on file) — the page excludes these from the
 * quadrants rather than assuming a $0 cost. Classification itself is computed
 * client-side so the popularity-factor control can recompute without refetching.
 */
export interface MenuEngineeringInputRow {
  clover_item_id: string | null;
  item_fingerprint: string;
  item_name: string;
  units: number;
  gross_sales_cents: number;
  plate_cost_cents: number | null;
}

export interface MenuEngineeringInputsResponse {
  days: number;
  items: MenuEngineeringInputRow[];
}

/**
 * Bundled cost metrics for the /costs dashboard (analytics-api
 * GET /admin/api/costs, ADR-0031 Phase 2). Every figure is resolved through the
 * governed metric registry (ADR-0030), so `definition` is the registry's vetted
 * prose and `value` traces to the same SQL the AI's get_metric uses. Omits
 * actual-COGS / yield-variance / labor / prime — those need data not yet
 * ingested (inventory depletion ADR-0028; Clover labor Phase 4) and render as
 * honest "not yet connected" states in the page.
 */
export interface CostMetricValue {
  value: number | null;
  unit: string;
  definition: string;
  label: string;
}

export interface CostsResponse {
  days: number;
  metrics: Record<string, CostMetricValue>;
  marginTrend: { business_date: string; value: number | null }[];
  /**
   * Real daily food-cost-% series (ADR-0573) for the Inventory overview sparkline,
   * replacing the former seeded cogs_trend. Sparse: only days with costed sales;
   * null on a day with none. Ratio (0..1).
   */
  costTrend: { business_date: string; value: number | null }[];
}

export interface ItemHourlyRow {
  business_date: string;
  local_hour: number | string;
  quantity: number | string;
  gross_sales_cents: number | string;
  line_count: number | string;
}

export interface ItemHourlyResponse {
  item_fingerprint: string;
  days: number;
  rows: ItemHourlyRow[];
}

export interface ItemModifierRow {
  modifier_name: string;
  modifier_count: number | string;
  modifier_total_cents: number | string;
  attach_rate: number | string;
}

export interface ItemModifiersResponse {
  item_fingerprint: string;
  days: number;
  line_count: number | string;
  modifiers: ItemModifierRow[];
}

export interface OpsHealthSummary {
  merchant_id: string;
  last_hourly_sweep_at: IsoDateTime;
  last_export_reconcile_at: IsoDateTime;
  webhook_lag_seconds: CountValue | null;
  open_repair_count: CountValue;
  failed_job_count: CountValue;
  dq_failed_count: CountValue;
  dirty_window_backlog: CountValue;
}

export interface OpsHeartbeat {
  component: string;
  instance_id: string | null;
  last_seen_at: IsoDateTime;
  age_seconds: CountValue | null;
  details: JsonObject | null;
}

export interface OpsJobCount {
  job_type: string;
  status: string;
  count: CountValue;
}

export interface OpsDirtyWindowCount {
  status: string;
  count: CountValue;
}

export interface OpsBackfillWindow {
  windowStart: string;
  windowEnd: string;
  status: string;
  failureCount: number;
  blockedAt: IsoDateTime;
  retryAfter: IsoDateTime;
  lastError: string | null;
  completedAt: IsoDateTime;
  parked: boolean;
}

export interface OpsHistoricalBackfill {
  expectedWindows: number;
  completedWindows: number;
  failedWindows: number;
  blockedWindows: number;
  progressPct: number;
  currentWindowStart: IsoDateTime;
  currentWindowEnd: IsoDateTime;
  currentWindowStatus: string;
  lastCompletedAt: IsoDateTime;
  lastError: string | null;
  nextHistoricalWindowAt: IsoDateTime;
  runningWindows: number;
  maxConcurrentWindows: number;
  windowsCompletedLast24h: number;
  estimatedCompletionAt: IsoDateTime;
  rowsWrittenTotal: number;
  warningWindows: number;
  parkedWindows: number;
  needsManualIntervention: boolean;
  attentionWindows: OpsBackfillWindow[];
}

export interface OpsDataRange {
  name: string;
  row_count: CountValue;
  min_time: IsoDateTime;
  max_time: IsoDateTime;
}

export interface OpsDataQualityCheck {
  check_name: string;
  status: string;
  severity: string | null;
  details: JsonObject | null;
  created_at: IsoDateTime;
}

// An unresolved raw-vs-mart reconciliation break: the latest reconcile for this
// business_date came back 'failed'. Cents deltas arrive as strings (bigint).
export interface OpsReconBreak {
  business_date: string;
  order_count_delta: CountValue;
  payment_total_delta_cents: CountValue;
  net_sales_delta_cents: CountValue;
  refund_delta_cents: CountValue;
  created_at: IsoDateTime;
}

export interface OpsOverviewResponse {
  merchantId: string;
  health: OpsHealthSummary | null;
  heartbeats: OpsHeartbeat[];
  jobCounts: OpsJobCount[];
  dirtyWindows: OpsDirtyWindowCount[];
  historicalBackfill: OpsHistoricalBackfill;
  dataRanges: OpsDataRange[];
  dqFailures: OpsDataQualityCheck[];
  reconBreaks: OpsReconBreak[];
}

export type CompletenessStatus = "present" | "missing" | "closed" | "warming_up" | "not_loaded";

export interface CompletenessDay {
  business_date: string;
  status: CompletenessStatus;
}

// Calendar coverage for the ops heatmap (analytics-api GET /admin/api/completeness).
// `days` is a bounded window; `olderMissing` counts holes before it so the 8-year
// answer survives a rolling window.
export interface CompletenessResponse {
  from: string;
  to: string;
  days: CompletenessDay[];
  olderMissing: number;
  summary: Partial<Record<CompletenessStatus, number>>;
}

export interface OpsJob {
  job_type: string;
  status: string;
  priority?: CountValue | null;
  window_start: IsoDateTime;
  window_end: IsoDateTime;
  attempt_count: CountValue;
  max_attempts: CountValue;
  run_after?: IsoDateTime;
  started_at?: IsoDateTime;
  completed_at?: IsoDateTime;
  last_error: string | null;
  created_at?: IsoDateTime;
  updated_at?: IsoDateTime;
}

export interface OpsJobsResponse {
  recentJobs: OpsJob[];
  failedJobs: OpsJob[];
  dataQualityChecks: OpsDataQualityCheck[];
}

export interface OpsWebhookVerification {
  id: number | string;
  code: string;
  received_at: string;
  used_at: IsoDateTime;
}

export interface OpsWebhookVerificationsResponse {
  verifications: OpsWebhookVerification[];
}

export interface DatabaseTableStats {
  schema: string;
  table_name: string;
  row_count: CountValue;
  bytes_total: CountValue;
  size_pretty: string;
  last_refreshed_at: IsoDateTime;
}

export interface DatabaseResponse {
  tables: DatabaseTableStats[];
  totals: {
    table_count: CountValue;
    bytes_total: CountValue;
    size_pretty: string;
  };
}

// Segment-mix breakdown for the Trends page (order type / tender / daypart) over a
// date range. Mirrors analytics-api's /admin/api/trends/breakdown response.
export interface BreakdownRow {
  key: string;
  value_cents: number;
  count: number;
}

export interface TrendsBreakdownResponse {
  from: string;
  to: string;
  order_type: BreakdownRow[];
  tender: BreakdownRow[];
  daypart: BreakdownRow[];
}

// Demand forecast (ADR-0032). Mirrors analytics-api's GET /admin/api/forecast: the
// stored forecast curve (value + ~80% band per future date, per metric) plus the
// model's own backtest accuracy. metric is "net_sales_cents" | "order_count".
export interface ForecastPoint {
  target_date: string;
  metric: string;
  value: number;
  lo: number;
  hi: number;
}

export interface ForecastBacktest {
  metric: string;
  mape: number | null;
  wape: number | null;
  sample_count: number;
}

export interface ForecastResponse {
  points: ForecastPoint[];
  backtest: ForecastBacktest[];
  generated_at: string | null;
}

export interface ForecastRunResult {
  merchantId: string;
  horizonDays: number;
  written: number;
  backtest: { metric: string; mape: number | null; wape: number | null; n: number }[];
}
