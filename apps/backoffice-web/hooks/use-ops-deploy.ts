"use client";

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  opsBuildApps,
  type BuildRunnerVar,
  type DeployDispatchResponse,
  type DeployMode,
  type DeployRequest,
  type OpsFreshnessResponse,
  type OpsRunnersResponse,
} from "@rop/contracts";
import type { WorkflowRunSummary } from "@/lib/github";
import {
  deriveDeployProgress,
  type DeployProgress,
} from "@/lib/ops/deploy-progress";
import {
  PipelineApiError,
  usePipelineRunDetail,
  type PipelineRunsResponse,
} from "./use-pipeline";

const RUNNERS_REFETCH_MS = 15_000;
const FRESHNESS_REFETCH_MS = 15_000;
const BUILD_RUNNER_STALE_MS = 60_000;
// While we're waiting for a just-dispatched run to surface, poll fast so the
// status flips from "dispatching" to the live run within a few seconds.
const DISCOVERY_REFETCH_MS = 4_000;

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: "include", cache: "no-store", ...init });
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

export function useOpsRunners() {
  return useQuery({
    queryKey: ["ops", "runners"],
    queryFn: () => fetchJson<OpsRunnersResponse>("/api/ops/runners"),
    staleTime: RUNNERS_REFETCH_MS,
    refetchInterval: RUNNERS_REFETCH_MS,
  });
}

export function useOpsFreshness() {
  return useQuery({
    queryKey: ["ops", "freshness"],
    queryFn: () => fetchJson<OpsFreshnessResponse>("/api/ops/freshness"),
    staleTime: FRESHNESS_REFETCH_MS,
    refetchInterval: FRESHNESS_REFETCH_MS,
  });
}

export function useBuildRunnerVar() {
  return useQuery({
    queryKey: ["ops", "build-runner"],
    queryFn: () => fetchJson<BuildRunnerVar>("/api/ops/build-runner"),
    staleTime: BUILD_RUNNER_STALE_MS,
  });
}

export function useSetBuildRunnerVar() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (value: string) =>
      fetchJson<BuildRunnerVar>("/api/ops/build-runner", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value }),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(["ops", "build-runner"], data);
      toast.success(`BUILD_RUNNER set to "${data.value || "—"}"`);
    },
    onError: (error) => {
      toast.error(
        `Couldn't save build routing: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    },
  });
}

export function useDeploy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (req: DeployRequest) =>
      fetchJson<DeployDispatchResponse>("/api/ops/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      }),
    onSuccess: () => {
      // A new run is about to appear — nudge the runs queries to discover it.
      queryClient.invalidateQueries({ queryKey: ["ops", "active-build-run"] });
      queryClient.invalidateQueries({ queryKey: ["ops", "pipeline", "runs"] });
    },
  });
}

// Fast poll used only while a deploy we just fired is being discovered. The
// component picks the newest build-images workflow_dispatch run from this list.
export function useActiveBuildRun(enabled: boolean) {
  return useQuery({
    queryKey: ["ops", "active-build-run"],
    queryFn: () => fetchJson<PipelineRunsResponse>("/api/ops/pipeline/runs"),
    enabled,
    staleTime: 0,
    refetchInterval: enabled ? DISCOVERY_REFETCH_MS : false,
  });
}

const BUILD_WORKFLOW_NAME = "Build and push images (GHCR)";

export function isBuildDispatchRun(run: WorkflowRunSummary): boolean {
  return (
    run.event === "workflow_dispatch" &&
    (run.workflowName === BUILD_WORKFLOW_NAME || run.name === BUILD_WORKFLOW_NAME)
  );
}

export interface DeployOptionsState {
  mode: DeployMode;
  skipDeploy: boolean;
}

export interface DeployController {
  options: DeployOptionsState;
  setOptions: Dispatch<SetStateAction<DeployOptionsState>>;
  live: boolean;
  progress: DeployProgress | null;
  activeRun: WorkflowRunSummary | null;
  dispatchError: Error | null;
  fire: () => void;
  retry: () => void;
  reset: () => void;
}

// Owns the deploy lifecycle: fire the dispatch, discover the run it created
// (by diffing build-dispatch run ids against a pre-fire snapshot so we never
// latch onto a previous run), then poll that run's jobs to drive live progress.
export function useDeployController(driftApps: readonly string[]): DeployController {
  const queryClient = useQueryClient();
  const deploy = useDeploy();
  const [options, setOptions] = useState<DeployOptionsState>({ mode: "incremental", skipDeploy: false });
  const [activeRunId, setActiveRunId] = useState<number | null>(null);
  const [dispatching, setDispatching] = useState(false);
  const knownRunIds = useRef<Set<number>>(new Set());
  // The options the in-flight deploy was fired with — kept in state (not a ref)
  // so render can read them to map the matrix/steps without a refs-in-render lint.
  const [activeOptions, setActiveOptions] = useState<DeployOptionsState>(options);

  const discovery = useActiveBuildRun(dispatching && activeRunId === null);
  useEffect(() => {
    if (!dispatching || activeRunId !== null) return;
    const fresh = (discovery.data?.runs ?? [])
      .filter(isBuildDispatchRun)
      .filter((run) => !knownRunIds.current.has(run.id))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (fresh[0]) {
      setActiveRunId(fresh[0].id);
      setDispatching(false);
    }
  }, [discovery.data, dispatching, activeRunId]);

  const detail = usePipelineRunDetail(activeRunId);
  const activeRun = detail.data?.run ?? null;

  const fireWith = useCallback(
    (opts: DeployOptionsState) => {
      const snapshot = queryClient.getQueryData<PipelineRunsResponse>(["ops", "pipeline", "runs"]);
      knownRunIds.current = new Set(
        (snapshot?.runs ?? []).filter(isBuildDispatchRun).map((run) => run.id),
      );
      setActiveOptions(opts);
      setActiveRunId(null);
      setDispatching(true);
      deploy.mutate(
        { mode: opts.mode, skipDeploy: opts.skipDeploy },
        { onError: () => setDispatching(false) },
      );
    },
    [deploy, queryClient],
  );

  const reset = useCallback(() => {
    setDispatching(false);
    setActiveRunId(null);
    deploy.reset();
  }, [deploy]);

  const live = dispatching || activeRunId !== null;
  const expectedApps =
    activeOptions.mode === "force_all" ? [...opsBuildApps] : [...driftApps];

  let progress: DeployProgress | null = null;
  if (live) {
    progress =
      activeRunId === null
        ? {
            phase: "dispatching",
            steps: {
              detect: "todo",
              build: "todo",
              push: "todo",
              deploy: activeOptions.skipDeploy ? "skipped" : "todo",
              tag: "todo",
            },
            apps: expectedApps.map((app) => ({ app, status: "queued" as const })),
            pct: 6,
          }
        : deriveDeployProgress(activeRun, detail.data?.jobs ?? [], {
            skipDeploy: activeOptions.skipDeploy,
            expectedApps,
          });
  }

  return {
    options,
    setOptions,
    live,
    progress,
    activeRun,
    dispatchError: deploy.isError && !live ? (deploy.error as Error) : null,
    fire: () => fireWith(options),
    retry: () => fireWith(activeOptions),
    reset,
  };
}
