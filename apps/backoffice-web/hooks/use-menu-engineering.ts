"use client";

import { useQuery } from "@tanstack/react-query";
import type { MenuEngineeringInputsResponse } from "@/lib/analytics-api/types";

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
 * Fetches the raw per-item menu-engineering inputs (units, realized revenue,
 * plate cost). Kasavana-Smith classification runs in the page via
 * `classifyMenu`, so the popularity-factor control recomputes the quadrants
 * without a refetch.
 */
export function useMenuEngineering(days = 30) {
  return useQuery({
    queryKey: ["menu-engineering", days],
    queryFn: () =>
      fetchJson<MenuEngineeringInputsResponse>(`/api/menu/engineering?days=${days}`),
    staleTime: STALE_MS,
    refetchInterval: STALE_MS
  });
}
