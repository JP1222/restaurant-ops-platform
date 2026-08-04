import type { BackfillRequeueRequest, BackfillRequeueResponse } from "@rop/contracts";
import { getServerEnv } from "@/lib/env";
import { mintAnalyticsTenantClaim } from "./tenant-claim";
import type {
  CompletenessResponse,
  DatabaseResponse,
  HealthzResponse,
  HourlyResponse,
  CostsResponse,
  ForecastResponse,
  ForecastRunResult,
  ItemHourlyResponse,
  ItemModifiersResponse,
  ItemsResponse,
  MenuEngineeringInputsResponse,
  OpsJobsResponse,
  OpsOverviewResponse,
  OpsWebhookVerificationsResponse,
  SalesResponse,
  TrendsBreakdownResponse,
} from "./types";

export class AnalyticsApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly bodyText: string,
    public readonly url: string,
    public readonly requestId?: string,
  ) {
    super(`analytics-api ${status}: ${bodyText.slice(0, 200)}`);
    this.name = "AnalyticsApiError";
  }
}

interface RequestOptions {
  authenticated?: boolean;
  signal?: AbortSignal;
  /**
   * HTTP method. Defaults to GET; the cost-sync admin endpoints are POST. Most
   * POSTs send no body (they pull from their own sources); pass `body` for the
   * ones that take a JSON payload (e.g. backfill requeue).
   */
  method?: "GET" | "POST";
  /**
   * Clover merchant id to scope the query to (multi-location, ADR-0018).
   * Omitted -> analytics-api falls back to its env-configured default store.
   */
  merchantId?: string;
  /** JSON request body, serialized + sent with Content-Type: application/json. */
  body?: unknown;
  /**
   * Correlation id forwarded as `x-request-id`; analytics-api adopts it as the
   * request scope id so this BFF call and the upstream logs share one id in
   * Loki. Generated per call when omitted.
   */
  requestId?: string;
}

type SalesArgs = { days: number } | { from: string; to: string };
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const env = getServerEnv();
  const url = new URL(path, env.INTERNAL_ANALYTICS_API_URL);
  // Multi-location (ADR-0018): scope to the active store. Omitted ->
  // analytics-api falls back to its env-configured default merchant.
  if (opts.merchantId) {
    url.searchParams.set("merchant_id", opts.merchantId);
  }
  const target = url.toString();
  const requestId = opts.requestId ?? crypto.randomUUID();
  const headers: Record<string, string> = {
    Accept: "application/json",
    "x-request-id": requestId,
  };

  if (opts.authenticated !== false) {
    headers.Authorization = `Bearer ${env.ANALYTICS_ADMIN_TOKEN}`;
    // Multi-tenant (ADR-0818 Phase 2c): attach the signed tenant claim so
    // analytics can verify the caller's tenant + that this merchant belongs to
    // it. No-op (null) until ANALYTICS_TENANT_SIGNING_KEY is configured.
    const tenantClaim = await mintAnalyticsTenantClaim(opts.merchantId);
    if (tenantClaim) {
      headers["x-tenant-claim"] = tenantClaim;
    }
  }

  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(target, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
    credentials: "omit",
    cache: "no-store",
  });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new AnalyticsApiError(res.status, bodyText, target, requestId);
  }

  return res.json() as Promise<T>;
}

export const analyticsApi = {
  healthz(opts: RequestOptions = {}) {
    return request<HealthzResponse>("/healthz", { ...opts, authenticated: false });
  },

  sales(args: SalesArgs, opts: RequestOptions = {}) {
    if ("days" in args) {
      if (!Number.isInteger(args.days) || args.days <= 0 || args.days > 365) {
        throw new RangeError(`days must be an integer in 1..365 (got ${args.days})`);
      }

      return request<SalesResponse>(`/admin/api/sales?days=${args.days}`, opts);
    }

    if (!ISO_DATE_RE.test(args.from) || !ISO_DATE_RE.test(args.to)) {
      throw new RangeError(`from/to must be YYYY-MM-DD (got from=${args.from}, to=${args.to})`);
    }
    if (args.from > args.to) {
      throw new RangeError(`from must be <= to (got from=${args.from}, to=${args.to})`);
    }

    const qs = new URLSearchParams({ from: args.from, to: args.to });
    return request<SalesResponse>(`/admin/api/sales?${qs.toString()}`, opts);
  },

  hourly(daysWindow: number, opts: RequestOptions = {}) {
    if (!Number.isInteger(daysWindow) || daysWindow <= 0 || daysWindow > 90) {
      throw new RangeError(`daysWindow must be an integer in 1..90 (got ${daysWindow})`);
    }

    return request<HourlyResponse>(`/admin/api/hourly?days=${daysWindow}`, opts);
  },

  items(daysWindow: number, opts: RequestOptions = {}) {
    if (!Number.isInteger(daysWindow) || daysWindow <= 0 || daysWindow > 90) {
      throw new RangeError(`daysWindow must be an integer in 1..90 (got ${daysWindow})`);
    }

    return request<ItemsResponse>(`/admin/api/items?days=${daysWindow}`, opts);
  },

  menuEngineering(daysWindow: number, opts: RequestOptions = {}) {
    if (!Number.isInteger(daysWindow) || daysWindow <= 0 || daysWindow > 90) {
      throw new RangeError(`daysWindow must be an integer in 1..90 (got ${daysWindow})`);
    }

    return request<MenuEngineeringInputsResponse>(
      `/admin/api/menu-engineering?days=${daysWindow}`,
      opts,
    );
  },

  costs(daysWindow: number, opts: RequestOptions = {}) {
    if (!Number.isInteger(daysWindow) || daysWindow <= 0 || daysWindow > 90) {
      throw new RangeError(`daysWindow must be an integer in 1..90 (got ${daysWindow})`);
    }

    return request<CostsResponse>(`/admin/api/costs?days=${daysWindow}`, opts);
  },

  trendsBreakdown(args: { from: string; to: string }, opts: RequestOptions = {}) {
    if (!ISO_DATE_RE.test(args.from) || !ISO_DATE_RE.test(args.to)) {
      throw new RangeError(`from/to must be YYYY-MM-DD (got from=${args.from}, to=${args.to})`);
    }
    if (args.from > args.to) {
      throw new RangeError(`from must be <= to (got from=${args.from}, to=${args.to})`);
    }

    const qs = new URLSearchParams({ from: args.from, to: args.to });
    return request<TrendsBreakdownResponse>(
      `/admin/api/trends/breakdown?${qs.toString()}`,
      opts,
    );
  },

  // Calendar completeness for the ops heatmap. Window/older-holes math is
  // server-side (defaults to a rolling ~13 months), so no args are required.
  completeness(opts: RequestOptions = {}) {
    return request<CompletenessResponse>("/admin/api/completeness", opts);
  },

  itemHourly(fingerprint: string, daysWindow: number, opts: RequestOptions = {}) {
    if (!Number.isInteger(daysWindow) || daysWindow <= 0 || daysWindow > 90) {
      throw new RangeError(`daysWindow must be an integer in 1..90 (got ${daysWindow})`);
    }

    const encoded = encodeURIComponent(fingerprint);
    return request<ItemHourlyResponse>(
      `/admin/api/items/${encoded}/hourly?days=${daysWindow}`,
      opts,
    );
  },

  itemModifiers(fingerprint: string, daysWindow: number, opts: RequestOptions = {}) {
    if (!Number.isInteger(daysWindow) || daysWindow <= 0 || daysWindow > 90) {
      throw new RangeError(`daysWindow must be an integer in 1..90 (got ${daysWindow})`);
    }

    const encoded = encodeURIComponent(fingerprint);
    return request<ItemModifiersResponse>(
      `/admin/api/items/${encoded}/modifiers?days=${daysWindow}`,
      opts,
    );
  },

  overview(opts: RequestOptions = {}) {
    return request<OpsOverviewResponse>("/admin/api/overview", opts);
  },

  jobs(opts: RequestOptions = {}) {
    return request<OpsJobsResponse>("/admin/api/jobs", opts);
  },

  webhookVerifications(opts: RequestOptions = {}) {
    return request<OpsWebhookVerificationsResponse>("/admin/webhook-verifications", opts);
  },

  database(opts: RequestOptions = {}) {
    return request<DatabaseResponse>("/admin/api/database", opts);
  },

  // Pull labor cost from inventory-api into mart.dim_labor_cost + refresh the prime
  // cost MV (ADR-0033 Phase 4b). POST, no body; analytics pulls from its configured
  // source. Called by the Backoffice labor-cost editor after the inventory write.
  syncLaborCosts(opts: RequestOptions = {}) {
    return request<{ received: number; written: number; refreshed: boolean }>(
      "/admin/api/sync-labor-costs",
      { ...opts, method: "POST" },
    );
  },

  // Pull count-based actual COGS from inventory-api into mart.dim_actual_cogs +
  // refresh the variance MV (ADR-0031). POST, no body; analytics pulls from its
  // configured source. Triggered after a Backoffice count write (the event that
  // changes actual COGS), mirroring syncLaborCosts.
  syncActualCogs(opts: RequestOptions = {}) {
    return request<{ received: number; written: number; refreshed: boolean }>(
      "/admin/api/sync-actual-cogs",
      { ...opts, method: "POST" },
    );
  },

  // Pull recipe plate costs from inventory-api into mart.dim_item_cost (ADR-0031,
  // Phase 1) — the sole write path for plate cost, which Menu Engineering and the
  // Cost dashboard's food-cost / gross-margin metrics read. POST, no body; plate
  // cost is brand-level so no merchant scope. Triggered after a Backoffice recipe
  // (BOM) save, mirroring syncLaborCosts / syncActualCogs. The periodic
  // mart-refresh-worker rebuilds the cost MVs that consume dim_item_cost.
  syncPlateCosts(opts: RequestOptions = {}) {
    return request<{ received: number; written: number }>(
      "/admin/api/sync-plate-costs",
      { ...opts, method: "POST" },
    );
  },

  // Demand forecast (ADR-0032): read the stored curve + backtest, and trigger a
  // recompute. Read is merchant-scoped via opts.merchantId; the run defaults to the
  // env store when no merchant is passed.
  forecast(opts: RequestOptions = {}) {
    return request<ForecastResponse>("/admin/api/forecast", opts);
  },

  runForecast(opts: RequestOptions = {}) {
    return request<ForecastRunResult>("/admin/api/forecast/run", { ...opts, method: "POST" });
  },

  // Operator requeue of historical backfill windows (P4): reset failed/blocked
  // windows to pending so the autonomous scheduler reprocesses them. Body carries
  // the action + optional ISO window range.
  requeueBackfill(body: BackfillRequeueRequest, opts: RequestOptions = {}) {
    return request<BackfillRequeueResponse>("/admin/api/backfill/requeue", {
      ...opts,
      method: "POST",
      body,
    });
  },
};
