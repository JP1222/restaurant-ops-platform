"use client";

import { useQuery } from "@tanstack/react-query";
import type { CostsResponse } from "@/lib/analytics-api/types";

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

/**
 * Fetches the bundled cost metrics (food cost %, gross margin, coverage, etc.)
 * for the Cost & Prime Cost dashboard. Every figure is registry-resolved
 * server-side (ADR-0030); the page only reads `value` + `definition` and applies
 * presentation (NRA bands, coverage gate).
 */
export function useCosts(days = 30) {
  return useQuery({
    queryKey: ["costs", days],
    queryFn: () => fetchJson<CostsResponse>(`/api/costs?days=${days}`),
    staleTime: STALE_MS,
    refetchInterval: STALE_MS
  });
}
