"use client";

import { useQuery } from "@tanstack/react-query";
import type { TopItemsView } from "@/lib/analytics-api/top-items-transform";

async function fetchTodayTopItems(): Promise<TopItemsView> {
  const response = await fetch("/api/today/top-items", { credentials: "include" });

  if (response.status === 401) {
    throw new Error("unauthenticated");
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`/api/today/top-items ${response.status}: ${body.slice(0, 200)}`);
  }

  return response.json() as Promise<TopItemsView>;
}

export function useTodayTopItems() {
  return useQuery({
    queryKey: ["today", "top-items"],
    queryFn: fetchTodayTopItems,
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
}
