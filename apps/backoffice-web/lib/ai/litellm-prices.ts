import type { ModelPrice } from "@/lib/ai/model-prices";

/**
 * LiteLLM price-oracle fetch + filter for the runtime price cache.
 *
 * LiteLLM's `model_prices_and_context_window.json` is the de-facto community price
 * map. The "Refresh prices" action / weekly cron fetches it, filters to the model
 * families this suite can run, and stores the result so the Usage & cost estimate
 * prices any newly-selected model without a code change. (The committed baked table
 * in model-prices.generated.json, produced by `pnpm ai:prices:sync`, is the deploy-
 * time default the cache layers over.)
 */

// Overridable to a pinned mirror (matches LiteLLM's own LITELLM_MODEL_COST_MAP_URL).
export const LITELLM_PRICE_URL =
  process.env.LITELLM_MODEL_COST_MAP_URL ??
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

// Catalog keys for the model families we run (chat / matcher / vision providers). We
// vendor every LiteLLM entry whose key matches one of these so a newly-selected model
// in the family is priced automatically. Anchored to the bare/namespaced forms an
// operator actually types (gemini-2.5-flash, deepseek-chat) — not the azure_/bedrock_/
// fireworks_ rehosts. openai-compatible endpoints are arbitrary and stay unpriced.
const PROVIDER_KEY_PATTERNS: readonly RegExp[] = [
  /^deepseek[/-]/i,
  /^gemini[/-]/i,
  /^(gpt-|chatgpt|o[1-9])/i,
  /^claude-/i,
];

// Convert one LiteLLM catalog entry (costs are per-TOKEN) to our per-1M ModelPrice.
// Returns null when the entry lacks the basic input/output costs we price on, so the
// caller skips it. Trims float noise (2.5e-8 * 1e6 = 0.0249…998) to keep values clean.
// Mirrors the extractor in scripts/ai-prices-sync.mjs (the baked-table generator).
export function litellmEntryToPrice(entry: unknown): ModelPrice | null {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;
  const input = e.input_cost_per_token;
  const output = e.output_cost_per_token;
  if (typeof input !== "number" || typeof output !== "number") return null;
  const per1M = (n: number) => Number((n * 1_000_000).toFixed(10));
  const price: ModelPrice = { inputPer1M: per1M(input), outputPer1M: per1M(output) };
  const cacheRead = e.cache_read_input_token_cost;
  if (typeof cacheRead === "number") price.cachedInputPer1M = per1M(cacheRead);
  return price;
}

// Filter a full LiteLLM catalog to our provider families, mapping each to our per-1M
// ModelPrice. Skips entries without usable costs (e.g. the `sample_spec` meta-entry).
export function selectProviderPrices(catalog: Record<string, unknown>): Record<string, ModelPrice> {
  const out: Record<string, ModelPrice> = {};
  for (const [key, entry] of Object.entries(catalog)) {
    if (!PROVIDER_KEY_PATTERNS.some((re) => re.test(key))) continue;
    const price = litellmEntryToPrice(entry);
    if (price) out[key] = price;
  }
  return out;
}

// Fetch + filter the LiteLLM price map. Throws on a non-OK response or timeout so the
// refresh caller can surface the failure (the existing cache is left untouched).
export async function fetchProviderPrices(): Promise<Record<string, ModelPrice>> {
  const res = await fetch(LITELLM_PRICE_URL, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`litellm_fetch_${res.status}`);
  const catalog = (await res.json()) as Record<string, unknown>;
  return selectProviderPrices(catalog);
}
