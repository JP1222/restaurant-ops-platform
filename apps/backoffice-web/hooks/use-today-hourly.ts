"use client";

import { useQuery } from "@tanstack/react-query";
import type { HourlyPulse } from "@/lib/analytics-api/hourly-transform";

async function fetchTodayHourly(): Promise<HourlyPulse> {
  const response = await fetch("/api/today/hourly", { credentials: "include" });

  if (response.status === 401) {
    throw new Error("unauthenticated");
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`/api/today/hourly ${response.status}: ${body.slice(0, 200)}`);
  }

  return response.json() as Promise<HourlyPulse>;
}

export function useTodayHourly() {
  return useQuery({
    queryKey: ["today", "hourly"],
    queryFn: fetchTodayHourly,
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
}
