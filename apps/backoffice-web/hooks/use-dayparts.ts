"use client";

import { useQuery } from "@tanstack/react-query";
import type { DaypartsView } from "@/lib/analytics-api/dayparts-transform";

const STALE_MS = 60_000;

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "include" });

  if (response.status === 401) {
    throw new Error("unauthenticated");
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${url} ${response.status}: ${body.slice(0, 200)}`);
  }

  return response.json() as Promise<T>;
}

export function useDayparts(days = 56) {
  return useQuery({
    queryKey: ["dayparts", days],
    queryFn: () => fetchJson<DaypartsView>(`/api/dayparts?days=${days}`),
    staleTime: STALE_MS
  });
}
