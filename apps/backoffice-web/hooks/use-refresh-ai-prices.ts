"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";

export interface RefreshAiPricesResult {
  modelCount: number;
  fetchedAt: string;
}

// Mutation for the Settings "Refresh prices" button: re-syncs the model price table from
// LiteLLM, then invalidates the usage report so its costs recompute against fresh prices.
export function useRefreshAiPrices() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<RefreshAiPricesResult> => {
      const res = await fetch("/api/ai/prices/refresh", {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`ai_price_refresh_failed_${res.status}`);
      return (await res.json()) as RefreshAiPricesResult;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["ai-usage"] });
    },
  });
}
