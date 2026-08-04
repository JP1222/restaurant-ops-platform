"use client";

import { useQuery } from "@tanstack/react-query";
import type { TrendsBreakdownResponse } from "@/lib/analytics-api/types";

async function fetchBreakdown(from: string, to: string): Promise<TrendsBreakdownResponse> {
  const qs = new URLSearchParams({ from, to });
  const response = await fetch(`/api/trends/breakdown?${qs.toString()}`, {
    credentials: "include",
  });

  if (response.status === 401) {
    throw new Error("unauthenticated");
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`/api/trends/breakdown ${response.status}: ${body.slice(0, 200)}`);
  }

  return response.json() as Promise<TrendsBreakdownResponse>;
}

/** Segment mix (order type / tender / daypart) for the selected Trends range. */
export function useTrendsBreakdown(from: string, to: string, enabled = true) {
  return useQuery({
    queryKey: ["trends-breakdown", from, to],
    queryFn: () => fetchBreakdown(from, to),
    enabled,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}
