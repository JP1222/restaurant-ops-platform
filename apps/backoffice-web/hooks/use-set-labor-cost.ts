"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { LaborCostSave } from "@rop/contracts";

interface SetLaborCostResult {
  ok: true;
  sync: { received: number; written: number; refreshed: boolean } | null;
}

async function postLaborCost(body: LaborCostSave): Promise<SetLaborCostResult> {
  const res = await fetch("/api/costs/labor", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body)
  });

  if (res.status === 401) {
    throw new Error("unauthenticated");
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`/api/costs/labor ${res.status}: ${text.slice(0, 200)}`);
  }

  return res.json() as Promise<SetLaborCostResult>;
}

/**
 * Saves the operator's labor cost (ADR-0033, Phase 4b) and, on success, invalidates
 * the costs query so the Labor % + Prime cost cards refetch and light up. The BFF
 * persists to inventory-api then triggers the analytics ingest + prime-cost MV refresh.
 */
export function useSetLaborCost() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: postLaborCost,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["costs"] });
    }
  });
}
