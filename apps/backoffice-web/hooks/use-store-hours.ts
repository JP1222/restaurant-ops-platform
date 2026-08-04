"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { StoreHoursResponse, StoreHoursUpdate } from "@rop/contracts";

const QUERY_KEY = ["store-hours"] as const;

async function fetchStoreHours(): Promise<StoreHoursResponse> {
  const res = await fetch("/api/store-hours", { credentials: "include" });
  if (!res.ok) {
    throw new Error(`/api/store-hours ${res.status}`);
  }
  return res.json() as Promise<StoreHoursResponse>;
}

export function useStoreHours() {
  return useQuery({ queryKey: QUERY_KEY, queryFn: fetchStoreHours, staleTime: 60_000 });
}

export function useSaveStoreHours() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (update: StoreHoursUpdate): Promise<StoreHoursResponse> => {
      const res = await fetch("/api/store-hours", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify(update),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `/api/store-hours ${res.status}`);
      }
      return res.json() as Promise<StoreHoursResponse>;
    },
    onSuccess: (data) => queryClient.setQueryData(QUERY_KEY, data),
  });
}
