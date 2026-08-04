import { saveModelPriceCache } from "@/lib/ai/db";
import { fetchProviderPrices } from "@/lib/ai/litellm-prices";

export interface RefreshPricesResult {
  modelCount: number;
  fetchedAt: string;
}

// Fetch the LiteLLM price map, filter to our provider families, and persist it to the
// price cache the Usage & cost estimate reads. Called by the Settings "Refresh prices"
// action and the weekly cron. Throws on fetch failure so the caller can surface it; the
// previously-cached table is left intact on failure (only a successful fetch overwrites).
export async function refreshModelPrices(): Promise<RefreshPricesResult> {
  const prices = await fetchProviderPrices();
  const fetchedAt = await saveModelPriceCache(prices);
  return { modelCount: Object.keys(prices).length, fetchedAt: fetchedAt.toISOString() };
}
