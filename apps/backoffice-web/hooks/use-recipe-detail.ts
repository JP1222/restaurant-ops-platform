"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { InventoryRecipeDetail, InventoryRecipeSave } from "@rop/contracts";

const STALE_MS = 60_000;

async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    credentials: "include",
    ...init,
    headers: {
      Accept: "application/json",
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...init.headers
    }
  });

  if (response.status === 401) {
    throw new Error("unauthenticated");
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${url} ${response.status}: ${body.slice(0, 200)}`);
  }
  return response.json() as Promise<T>;
}

export interface UseRecipeDetailReturn {
  data: InventoryRecipeDetail | undefined;
  isLoading: boolean;
  isError: boolean;
  save: (payload: InventoryRecipeSave) => void;
  isSaving: boolean;
  saveError: Error | null;
  saved: boolean;
}

// Read + write a single recipe for the editor (S2). Reads via the BFF
// GET /api/inventory/recipes/:id; saves via PUT. A successful save updates this
// recipe's cache and invalidates the inventory dataset so the recipes list and
// COGS reflect the new BOM. `who` is irrelevant here — a recipe edit is catalog
// config, not a stock movement.
export function useRecipeDetail(id: string): UseRecipeDetailReturn {
  const queryClient = useQueryClient();
  const queryKey = React.useMemo(() => ["inventory", "recipe", id] as const, [id]);

  const query = useQuery({
    queryKey,
    queryFn: () =>
      fetchJson<InventoryRecipeDetail>(`/api/inventory/recipes/${encodeURIComponent(id)}`),
    staleTime: STALE_MS,
    enabled: id.length > 0
  });

  const mutation = useMutation({
    mutationFn: (payload: InventoryRecipeSave) =>
      fetchJson<InventoryRecipeDetail>(`/api/inventory/recipes/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify(payload)
      }),
    onSuccess: (detail) => {
      queryClient.setQueryData(queryKey, detail);
      void queryClient.invalidateQueries({ queryKey: ["inventory"] });
    }
  });

  return {
    data: query.data,
    isLoading: query.isLoading,
    isError: query.isError,
    save: (payload: InventoryRecipeSave) => mutation.mutate(payload),
    isSaving: mutation.isPending,
    saveError: (mutation.error as Error | null) ?? null,
    saved: mutation.isSuccess
  };
}
