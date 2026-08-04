"use client";

import { useQuery } from "@tanstack/react-query";
import type { PackageVersion, WorkflowJob, WorkflowRunSummary } from "@/lib/github";

const ACTIVE_REFETCH_MS = 6_000;
const TIMELINE_REFETCH_MS = 15_000;
const IMAGES_REFETCH_MS = 60_000;
const SERVICES_REFETCH_MS = 20_000;

export class PipelineApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly errorCode: string | null,
    public readonly body: string,
  ) {
    super(`pipeline ${status}: ${errorCode ?? body.slice(0, 100)}`);
    this.name = "PipelineApiError";
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "include", cache: "no-store" });
  if (res.status === 401) throw new PipelineApiError(401, "unauthenticated", "");
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let errorCode: string | null = null;
    try {
      errorCode = (JSON.parse(body) as { error?: string }).error ?? null;
    } catch {
      /* not JSON — leave null */
    }
    throw new PipelineApiError(res.status, errorCode, body.slice(0, 200));
  }
  return res.json() as Promise<T>;
}

export interface PipelineRunsResponse {
  runs: WorkflowRunSummary[];
}

export interface PipelineRunDetailResponse {
  run: WorkflowRunSummary;
  jobs: WorkflowJob[];
}

export interface PipelineImagesResponse {
  images: Array<{
    app: string;
    packageName: string;
    mainTag: PackageVersion | null;
    latestVersions: PackageVersion[];
    error: string | null;
  }>;
}

export interface PipelineServicesResponse {
  overall: "healthy" | "degraded" | "unhealthy";
  services: Array<{
    app: string;
    label: string;
    url: string;
    status: "healthy" | "unhealthy" | "unknown";
    httpStatus: number | null;
    latencyMs: number | null;
    error: string | null;
    checkedAt: string;
  }>;
  checkedAt: string;
}

export function usePipelineRuns() {
  return useQuery({
    queryKey: ["ops", "pipeline", "runs"],
    queryFn: () => fetchJson<PipelineRunsResponse>("/api/ops/pipeline/runs"),
    staleTime: TIMELINE_REFETCH_MS,
    refetchInterval: TIMELINE_REFETCH_MS,
  });
}

export function usePipelineRunDetail(runId: number | null) {
  return useQuery({
    queryKey: ["ops", "pipeline", "run", runId],
    queryFn: () => fetchJson<PipelineRunDetailResponse>(`/api/ops/pipeline/runs/${runId}`),
    enabled: typeof runId === "number" && runId > 0,
    // Active polling cadence: when a run is open in the detail pane it might
    // be in-flight. Use the tighter cadence so the flowchart edges animate.
    staleTime: ACTIVE_REFETCH_MS,
    refetchInterval: (q) => {
      const data = q.state.data as PipelineRunDetailResponse | undefined;
      if (!data) return ACTIVE_REFETCH_MS;
      // Slow down once the run is terminal — no point polling a completed run.
      return data.run.status === "completed" ? TIMELINE_REFETCH_MS * 4 : ACTIVE_REFETCH_MS;
    },
  });
}

export function usePipelineImages() {
  return useQuery({
    queryKey: ["ops", "pipeline", "images"],
    queryFn: () => fetchJson<PipelineImagesResponse>("/api/ops/pipeline/images"),
    staleTime: IMAGES_REFETCH_MS,
    refetchInterval: IMAGES_REFETCH_MS,
  });
}

export function usePipelineServices() {
  return useQuery({
    queryKey: ["ops", "pipeline", "services"],
    queryFn: () => fetchJson<PipelineServicesResponse>("/api/ops/pipeline/services"),
    staleTime: SERVICES_REFETCH_MS,
    refetchInterval: SERVICES_REFETCH_MS,
  });
}
