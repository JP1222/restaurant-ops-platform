// Type stub for the JS dev-script so TypeScript tests can import its pure helper.
// The runtime implementation lives in ai-prices-sync.mjs.
export interface SyncedModelPrice {
  inputPer1M: number;
  cachedInputPer1M?: number;
  outputPer1M: number;
}

export function litellmEntryToPrice(entry: unknown): SyncedModelPrice | null;
