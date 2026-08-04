import {
  aggregateAiUsageSince,
  loadModelPriceCache,
  recordAiUsageEvent,
  type AiUsageWrite,
} from "@/lib/ai/db";
import { errorMessage, logErrorEvent } from "@/lib/ai/log";
import { priceFor, type ModelPrice } from "@/lib/ai/model-prices";

/**
 * AI Usage & cost — pricing + aggregation for the Settings → AI Assistant card.
 *
 * The numbers here are an ESTIMATE from logged token counts at published list
 * prices — a guide, not a bill. Models without a price entry are reported with a
 * null cost (the UI shows "—") rather than a misleading $0, and the totals carry a
 * `hasUnpriced` flag so the figure reads as a floor.
 */

// Estimated USD for one (modelId, tokens) pairing. The per-model rate comes from
// `priceFor` (LiteLLM-synced table + operator overrides). Cache-hit tokens are billed at
// the cheaper `cachedInputPer1M` (falling back to the full input rate when no cache price
// is on file). null when the model has no price at all — the caller renders that as
// unpriced rather than zero. `cachedInputTokens` is the subset of `inputTokens` cached.
export function estimateCostUsd(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0,
  livePrices?: Record<string, ModelPrice> | null,
): number | null {
  const price = priceFor(modelId, livePrices);
  if (!price) return null;
  // Clamp: cached can never exceed total input (defensive against odd provider reports).
  const cached = Math.max(0, Math.min(cachedInputTokens, inputTokens));
  const uncached = inputTokens - cached;
  const cachedRate = price.cachedInputPer1M ?? price.inputPer1M;
  return (
    (uncached / 1_000_000) * price.inputPer1M +
    (cached / 1_000_000) * cachedRate +
    (outputTokens / 1_000_000) * price.outputPer1M
  );
}

export type AiUsagePeriod = "7d" | "month" | "last";

export function parseUsagePeriod(raw: string | null): AiUsagePeriod {
  return raw === "month" || raw === "last" ? raw : "7d";
}

// [since, until) for a period. UTC-based: "this month"/"last month" use UTC month
// boundaries — fine for an estimate (not a TZ-exact billing window). new Date() is a
// runtime call (this is a route handler, not a workflow script), so it's available.
export function periodRange(period: AiUsagePeriod, now: Date = new Date()): { since: Date; until: Date } {
  if (period === "7d") {
    return { since: new Date(now.getTime() - 7 * 86_400_000), until: now };
  }
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  if (period === "month") {
    return { since: new Date(Date.UTC(y, m, 1)), until: now };
  }
  // last month: [first of last month, first of this month)
  return { since: new Date(Date.UTC(y, m - 1, 1)), until: new Date(Date.UTC(y, m, 1)) };
}

export interface AiUsageRow {
  modelId: string;
  feature: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** null = no list price on file for this model. */
  estCostUsd: number | null;
}

export interface AiUsageReport {
  period: AiUsagePeriod;
  rows: AiUsageRow[];
  totals: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    /** Sum of the PRICED rows only — a floor when `hasUnpriced` is true. */
    estCostUsd: number;
    hasUnpriced: boolean;
  };
  /** When the live price cache was last refreshed (ISO), or null = using the baked table. */
  pricesUpdatedAt: string | null;
}

export async function buildUsageReport(period: AiUsagePeriod): Promise<AiUsageReport> {
  const { since, until } = periodRange(period);
  // Load the aggregate and the live price cache together; the cache lets the estimate
  // price any model an operator has selected since the baked table was generated.
  const [aggregate, priceCache] = await Promise.all([
    aggregateAiUsageSince(since, until),
    loadModelPriceCache(),
  ]);
  const livePrices = priceCache?.prices ?? null;

  const rows: AiUsageRow[] = aggregate
    .map((r) => ({
      modelId: r.modelId,
      feature: r.feature,
      requests: r.requests,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      estCostUsd: estimateCostUsd(
        r.modelId,
        r.inputTokens,
        r.outputTokens,
        r.cachedInputTokens,
        livePrices,
      ),
    }))
    // Costliest first, then by request volume — the rows an operator cares about on top.
    .sort((a, b) => (b.estCostUsd ?? 0) - (a.estCostUsd ?? 0) || b.requests - a.requests);

  const totals = rows.reduce(
    (t, r) => ({
      requests: t.requests + r.requests,
      inputTokens: t.inputTokens + r.inputTokens,
      outputTokens: t.outputTokens + r.outputTokens,
      estCostUsd: t.estCostUsd + (r.estCostUsd ?? 0),
      hasUnpriced: t.hasUnpriced || r.estCostUsd === null,
    }),
    { requests: 0, inputTokens: 0, outputTokens: 0, estCostUsd: 0, hasUnpriced: false },
  );

  return {
    period,
    rows,
    totals,
    pricesUpdatedAt: priceCache?.fetchedAt.toISOString() ?? null,
  };
}

// Fire-and-forget usage write for the call sites. The backoffice runs as a
// persistent node server (not edge/lambda), so an un-awaited insert still completes;
// a failure is logged, never thrown — the ledger must not break the AI call it tracks.
export function recordAiUsage(event: AiUsageWrite): void {
  void recordAiUsageEvent(event).catch((error) => {
    logErrorEvent({
      scope: "backoffice.api.ai.usage.record",
      message: errorMessage(error, "usage_record_failed"),
      context: { feature: event.feature, modelId: event.modelId },
    });
  });
}
