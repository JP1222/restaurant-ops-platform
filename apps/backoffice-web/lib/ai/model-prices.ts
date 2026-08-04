import aliases from "@/lib/ai/model-aliases.json";
import generated from "@/lib/ai/model-prices.generated.json";

/**
 * AI model prices — sourced from LiteLLM's community price oracle, not hand-maintained.
 *
 * Two concerns kept apart:
 *  - WHAT models we use → `model-aliases.json` (our internal id → LiteLLM catalog key).
 *    Slow-changing; hand-edited only when we add/swap a model. It also doubles as the
 *    manifest of catalog keys `pnpm ai:prices:sync` vendors, so identity entries (id ===
 *    key) are intentional, not redundant.
 *  - WHAT they cost → `model-prices.generated.json` (synced; never hand-edit).
 *
 * `priceFor` is the single read path. Cost is still an ESTIMATE (logged tokens × list
 * price); an unknown model resolves to null so the UI shows "—", never a misleading $0.
 */

/** USD per 1,000,000 tokens: cache-MISS input, optional cache-HIT input, output. */
export interface ModelPrice {
  inputPer1M: number;
  /** Cache-HIT input rate; absent → cached tokens fall back to the full `inputPer1M`. */
  cachedInputPer1M?: number;
  outputPer1M: number;
}

const MODEL_ALIASES: Record<string, string> = aliases;
const SYNCED_PRICES: Record<string, ModelPrice> = generated.prices;

// Operator overrides — checked first, so they WIN over synced data. For special contract
// rates, or models the LiteLLM catalog doesn't carry. `deepseek-v4-flash` has no catalog
// "flash" tier, so its rate is pinned here (CONFIRM against DeepSeek's pricing page).
export const PRICE_OVERRIDES: Record<string, ModelPrice> = {
  "deepseek-v4-flash": { inputPer1M: 0.07, cachedInputPer1M: 0.0028, outputPer1M: 0.28 },
};

// Resolve a logged model id to its price. Precedence: an operator override wins, then the
// live LiteLLM-synced cache (passed in by the cost read path — covers any newly-selected
// model), then the committed baked table, else null (= unpriced, UI shows "—"). Lookups
// are by the id's catalog key (aliased, or the id verbatim). `live` is pure input so this
// stays a pure function (no DB import) — the caller loads the cache once and threads it.
export function priceFor(
  modelId: string,
  live?: Record<string, ModelPrice> | null,
): ModelPrice | null {
  const key = MODEL_ALIASES[modelId] ?? modelId;
  return PRICE_OVERRIDES[modelId] ?? live?.[key] ?? SYNCED_PRICES[key] ?? null;
}
