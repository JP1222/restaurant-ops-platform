"use client";

import { useQuery } from "@tanstack/react-query";
import type { TodayResponse } from "@/lib/analytics-api/today-shape";

async function fetchToday(): Promise<TodayResponse> {
  const response = await fetch("/api/today", { credentials: "include" });

  if (response.status === 401) {
    throw new Error("unauthenticated");
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`/api/today ${response.status}: ${body.slice(0, 200)}`);
  }

  return response.json() as Promise<TodayResponse>;
}

export function useToday() {
  return useQuery({
    queryKey: ["today"],
    queryFn: fetchToday,
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
}
