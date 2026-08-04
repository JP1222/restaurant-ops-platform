"use client";

import { useQuery } from "@tanstack/react-query";
import type { InsightsResponse } from "@rop/contracts";

async function fetchTodayInsights(): Promise<InsightsResponse> {
  const response = await fetch("/api/today/insights", { credentials: "include" });

  if (response.status === 401) {
    throw new Error("unauthenticated");
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`/api/today/insights ${response.status}: ${body.slice(0, 200)}`);
  }

  return response.json() as Promise<InsightsResponse>;
}

export function useTodayInsights() {
  return useQuery({
    queryKey: ["today", "insights"],
    queryFn: fetchTodayInsights,
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
}
