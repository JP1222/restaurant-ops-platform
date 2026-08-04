"use client";

import { useQuery } from "@tanstack/react-query";
import type {
  TrendGranularity,
  TrendMetric,
  TrendsView,
} from "@/lib/analytics-api/trends-transform";

export interface UseTrendsArgs {
  from: string;
  to: string;
  metric: TrendMetric;
  grain: TrendGranularity;
  enabled?: boolean;
}

async function fetchTrends(args: Omit<UseTrendsArgs, "enabled">): Promise<TrendsView> {
  const qs = new URLSearchParams({
    from: args.from,
    to: args.to,
    metric: args.metric,
    grain: args.grain,
  });
  const response = await fetch(`/api/trends?${qs.toString()}`, { credentials: "include" });

  if (response.status === 401) {
    throw new Error("unauthenticated");
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`/api/trends ${response.status}: ${body.slice(0, 200)}`);
  }

  return response.json() as Promise<TrendsView>;
}

export function useTrends(args: UseTrendsArgs) {
  return useQuery({
    queryKey: ["trends", args.from, args.to, args.metric, args.grain],
    queryFn: () => fetchTrends(args),
    enabled: args.enabled !== false,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}
