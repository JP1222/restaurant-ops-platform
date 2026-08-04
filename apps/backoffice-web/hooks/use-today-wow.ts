"use client";

import { useQuery } from "@tanstack/react-query";
import type { WeekVsWeekView } from "@/lib/analytics-api/wow-transform";

async function fetchTodayWow(): Promise<WeekVsWeekView> {
  const response = await fetch("/api/today/wow", { credentials: "include" });

  if (response.status === 401) {
    throw new Error("unauthenticated");
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`/api/today/wow ${response.status}: ${body.slice(0, 200)}`);
  }

  return response.json() as Promise<WeekVsWeekView>;
}

export function useTodayWow() {
  return useQuery({
    queryKey: ["today", "wow"],
    queryFn: fetchTodayWow,
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
}
