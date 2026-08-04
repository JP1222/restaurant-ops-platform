"use client";

import { useQuery } from "@tanstack/react-query";
import type { CompareView } from "@/lib/compare/compare-transform";
import type { CompareFilters } from "@/lib/compare/url-state";

async function fetchCompare(filters: CompareFilters): Promise<CompareView> {
  const query = new URLSearchParams({
    primary_from: filters.primary_from,
    primary_to: filters.primary_to,
    compare_from: filters.compare_from,
    compare_to: filters.compare_to,
    metric: filters.metric,
    grain: filters.grain,
  });
  const response = await fetch(`/api/compare?${query.toString()}`, { credentials: "include" });

  if (response.status === 401) {
    throw new Error("unauthenticated");
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`/api/compare ${response.status}: ${body.slice(0, 200)}`);
  }

  return response.json() as Promise<CompareView>;
}

export function useCompare(filters: CompareFilters) {
  return useQuery({
    queryKey: [
      "compare",
      filters.primary_from,
      filters.primary_to,
      filters.compare_from,
      filters.compare_to,
      filters.metric,
      filters.grain,
    ],
    queryFn: () => fetchCompare(filters),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}
