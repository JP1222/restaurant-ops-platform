"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { BackfillRequeueRequest, BackfillRequeueResponse } from "@rop/contracts";
import type {
  CompletenessResponse,
  DatabaseResponse,
  OpsJobsResponse,
  OpsOverviewResponse,
  OpsWebhookVerificationsResponse,
} from "@/lib/analytics-api/types";

const OPS_STALE_MS = 15_000;
const DATABASE_STALE_MS = 60_000;

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

export function useOpsOverview() {
  return useQuery({
    queryKey: ["ops", "overview"],
    queryFn: () => fetchJson<OpsOverviewResponse>("/api/ops/overview"),
    staleTime: OPS_STALE_MS,
    refetchInterval: OPS_STALE_MS,
  });
}

export function useOpsCompleteness() {
  return useQuery({
    queryKey: ["ops", "completeness"],
    queryFn: () => fetchJson<CompletenessResponse>("/api/ops/completeness"),
    staleTime: DATABASE_STALE_MS,
  });
}

export function useOpsJobs() {
  return useQuery({
    queryKey: ["ops", "jobs"],
    queryFn: () => fetchJson<OpsJobsResponse>("/api/ops/jobs"),
    staleTime: OPS_STALE_MS,
    refetchInterval: OPS_STALE_MS,
  });
}

export function useOpsWebhooks() {
  return useQuery({
    queryKey: ["ops", "webhooks"],
    queryFn: () => fetchJson<OpsWebhookVerificationsResponse>("/api/ops/webhooks"),
    staleTime: OPS_STALE_MS,
    refetchInterval: OPS_STALE_MS,
  });
}

export function useOpsDatabase() {
  return useQuery({
    queryKey: ["ops", "database"],
    queryFn: () => fetchJson<DatabaseResponse>("/api/ops/database"),
    staleTime: DATABASE_STALE_MS,
    refetchInterval: DATABASE_STALE_MS,
  });
}

// Operator requeue of historical backfill windows (P4). On success the ops
// overview is invalidated so the Backfill card reflects the reset windows.
export function useRequeueBackfill() {
  const queryClient = useQueryClient();
  return useMutation<BackfillRequeueResponse, Error, BackfillRequeueRequest>({
    mutationFn: async (body) => {
      const response = await fetch("/api/ops/backfill", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`/api/ops/backfill ${response.status}: ${text.slice(0, 200)}`);
      }
      return response.json() as Promise<BackfillRequeueResponse>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["ops", "overview"] });
    },
  });
}
