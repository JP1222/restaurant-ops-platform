import { getServerEnv } from "@/lib/env";

const GITHUB_API_BASE = "https://api.github.com";

// The production deploy chain. Dispatch + run history target this single
// manual-only workflow (ADR-0014). Deploy source-of-truth is always `main`.
export const BUILD_WORKFLOW_FILE = "build-images.yml";
// The last-built marker lives as `.last-built` on the orphan `deploy-state`
// branch (NOT a git tag — see build-images.yml `advance-marker` for why the
// tag approach can't be pushed by the Actions GITHUB_TOKEN). getLastBuiltSha()
// resolves the deployed SHA from it.
export const DEPLOY_STATE_BRANCH = "deploy-state";
export const LAST_BUILT_FILE = ".last-built";
export const DEFAULT_DEPLOY_REF = "main";

export class GithubApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly bodyText: string,
    public readonly url: string,
  ) {
    super(`github ${status}: ${bodyText.slice(0, 200)}`);
    this.name = "GithubApiError";
  }
}

interface GhRequestOptions {
  signal?: AbortSignal;
  accept?: string;
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  // JSON request body for POST/PATCH (e.g. workflow dispatch). Serialized here.
  body?: unknown;
}

async function ghFetch(path: string, opts: GhRequestOptions = {}): Promise<Response> {
  const env = getServerEnv();
  const url = `${GITHUB_API_BASE}${path}`;
  const headers: Record<string, string> = {
    Accept: opts.accept ?? "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (env.GITHUB_PIPELINE_TOKEN) {
    headers.Authorization = `Bearer ${env.GITHUB_PIPELINE_TOKEN}`;
  }
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(url, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
    cache: "no-store",
  });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new GithubApiError(res.status, bodyText, url);
  }

  return res;
}

async function ghRequest<T>(path: string, opts: GhRequestOptions = {}): Promise<T> {
  const res = await ghFetch(path, opts);
  return res.json() as Promise<T>;
}

// For endpoints that return 204 No Content (workflow dispatch, variable PATCH).
async function ghVoid(path: string, opts: GhRequestOptions = {}): Promise<void> {
  await ghFetch(path, opts);
}

export interface WorkflowRunSummary {
  id: number;
  name: string;
  workflowId: number;
  workflowName: string;
  headBranch: string | null;
  headSha: string;
  event: string;
  status: "queued" | "in_progress" | "completed" | string;
  conclusion: string | null;
  runNumber: number;
  runAttempt: number;
  createdAt: string;
  updatedAt: string;
  runStartedAt: string;
  htmlUrl: string;
  actorLogin: string | null;
  displayTitle: string | null;
}

export interface WorkflowJobStep {
  name: string;
  status: string;
  conclusion: string | null;
  number: number;
  startedAt: string | null;
  completedAt: string | null;
}

export interface WorkflowJob {
  id: number;
  runId: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  runnerName: string | null;
  htmlUrl: string;
  steps: WorkflowJobStep[];
}

export interface PackageVersion {
  id: number;
  name: string;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
  tags: string[];
}

export interface RunnerSummary {
  id: number;
  name: string;
  os: string | null;
  status: "online" | "offline";
  busy: boolean;
  labels: string[];
}

export interface RepoVariable {
  name: string;
  value: string;
  updatedAt: string | null;
}

export interface CommitComparison {
  baseSha: string | null;
  baseDate: string | null;
  files: string[];
}

function mapRunner(raw: Record<string, unknown>): RunnerSummary {
  const labels = ((raw.labels as Array<{ name?: string }> | undefined) ?? [])
    .map((l) => l.name ?? "")
    .filter(Boolean);
  return {
    id: raw.id as number,
    name: raw.name as string,
    os: (raw.os as string | null) ?? null,
    status: (raw.status as string) === "online" ? "online" : "offline",
    busy: Boolean(raw.busy),
    labels,
  };
}

function mapRun(raw: Record<string, unknown>): WorkflowRunSummary {
  return {
    id: raw.id as number,
    name: (raw.name as string) ?? "",
    workflowId: raw.workflow_id as number,
    workflowName: ((raw as { workflow_name?: string }).workflow_name) ?? (raw.name as string) ?? "",
    headBranch: (raw.head_branch as string | null) ?? null,
    headSha: raw.head_sha as string,
    event: raw.event as string,
    status: raw.status as string,
    conclusion: (raw.conclusion as string | null) ?? null,
    runNumber: raw.run_number as number,
    runAttempt: raw.run_attempt as number,
    createdAt: raw.created_at as string,
    updatedAt: raw.updated_at as string,
    runStartedAt: (raw.run_started_at as string) ?? (raw.created_at as string),
    htmlUrl: raw.html_url as string,
    actorLogin: ((raw.actor as { login?: string } | null) ?? null)?.login ?? null,
    displayTitle: ((raw as { display_title?: string }).display_title) ?? null,
  };
}

function mapJob(raw: Record<string, unknown>): WorkflowJob {
  const steps = ((raw.steps as Array<Record<string, unknown>> | undefined) ?? []).map((step) => ({
    name: step.name as string,
    status: step.status as string,
    conclusion: (step.conclusion as string | null) ?? null,
    number: step.number as number,
    startedAt: (step.started_at as string | null) ?? null,
    completedAt: (step.completed_at as string | null) ?? null,
  }));
  return {
    id: raw.id as number,
    runId: raw.run_id as number,
    name: raw.name as string,
    status: raw.status as string,
    conclusion: (raw.conclusion as string | null) ?? null,
    startedAt: (raw.started_at as string | null) ?? null,
    completedAt: (raw.completed_at as string | null) ?? null,
    runnerName: (raw.runner_name as string | null) ?? null,
    htmlUrl: raw.html_url as string,
    steps,
  };
}

export const githubApi = {
  async listRecentRuns(opts: { perPage?: number; signal?: AbortSignal } = {}) {
    const env = getServerEnv();
    const perPage = Math.min(opts.perPage ?? 20, 100);
    const raw = await ghRequest<{ workflow_runs: Array<Record<string, unknown>> }>(
      `/repos/${env.GITHUB_REPO_OWNER}/${env.GITHUB_REPO_NAME}/actions/runs?per_page=${perPage}`,
      { signal: opts.signal },
    );
    return raw.workflow_runs.map(mapRun);
  },

  async getRun(runId: number, opts: { signal?: AbortSignal } = {}) {
    const env = getServerEnv();
    const raw = await ghRequest<Record<string, unknown>>(
      `/repos/${env.GITHUB_REPO_OWNER}/${env.GITHUB_REPO_NAME}/actions/runs/${runId}`,
      { signal: opts.signal },
    );
    return mapRun(raw);
  },

  async listJobs(runId: number, opts: { signal?: AbortSignal } = {}) {
    const env = getServerEnv();
    const raw = await ghRequest<{ jobs: Array<Record<string, unknown>> }>(
      `/repos/${env.GITHUB_REPO_OWNER}/${env.GITHUB_REPO_NAME}/actions/runs/${runId}/jobs?per_page=100`,
      { signal: opts.signal },
    );
    return raw.jobs.map(mapJob);
  },

  async listPackageVersions(
    packageName: string,
    opts: { signal?: AbortSignal; perPage?: number } = {},
  ) {
    const env = getServerEnv();
    const perPage = Math.min(opts.perPage ?? 10, 100);
    const ownerLc = env.GITHUB_REPO_OWNER.toLowerCase();
    // Container packages live under /users/<owner>/packages/container/<name>/versions.
    // Requires `read:packages` on the PAT (works for private + public).
    const raw = await ghRequest<Array<Record<string, unknown>>>(
      `/users/${ownerLc}/packages/container/${encodeURIComponent(packageName)}/versions?per_page=${perPage}`,
      { signal: opts.signal },
    );
    return raw.map<PackageVersion>((v) => {
      const metadata = (v.metadata as { container?: { tags?: string[] } } | undefined) ?? {};
      return {
        id: v.id as number,
        name: v.name as string,
        createdAt: v.created_at as string,
        updatedAt: v.updated_at as string,
        htmlUrl: v.html_url as string,
        tags: metadata.container?.tags ?? [],
      };
    });
  },

  // Self-hosted runner fleet. Requires `administration:read` on the PAT.
  async listRunners(opts: { signal?: AbortSignal } = {}) {
    const env = getServerEnv();
    const raw = await ghRequest<{ runners?: Array<Record<string, unknown>> }>(
      `/repos/${env.GITHUB_REPO_OWNER}/${env.GITHUB_REPO_NAME}/actions/runners?per_page=100`,
      { signal: opts.signal },
    );
    return (raw.runners ?? []).map(mapRunner);
  },

  // Runs for one workflow file (newest first), e.g. resolving the run a deploy
  // just created. Requires `actions:read`.
  async listWorkflowRuns(
    workflowFile: string,
    opts: { perPage?: number; signal?: AbortSignal } = {},
  ) {
    const env = getServerEnv();
    const perPage = Math.min(opts.perPage ?? 10, 100);
    const raw = await ghRequest<{ workflow_runs: Array<Record<string, unknown>> }>(
      `/repos/${env.GITHUB_REPO_OWNER}/${env.GITHUB_REPO_NAME}/actions/workflows/${workflowFile}/runs?per_page=${perPage}`,
      { signal: opts.signal },
    );
    return raw.workflow_runs.map(mapRun);
  },

  // The workflow_dispatch REST call returns 204 with no run id. After firing it
  // we list recent build-images dispatch runs and take the newest as the run we
  // just created (best-effort; the client also polls if this races).
  async findRecentDispatchRun(opts: { signal?: AbortSignal } = {}) {
    const runs = await this.listWorkflowRuns(BUILD_WORKFLOW_FILE, { perPage: 5, signal: opts.signal });
    const dispatched = runs
      .filter((r) => r.event === "workflow_dispatch")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return dispatched[0] ?? null;
  },

  // Fire the production deploy. Requires `actions:write`.
  // NOTE: `skip_deploy` MUST be sent as a JSON boolean — the workflow gates the
  // deploy step with the expression `if: inputs.skip_deploy != true`, which
  // would treat the string "true" as not-equal-to-boolean-true and deploy anyway.
  async dispatchBuildImages(
    input: { forceAll: boolean; skipDeploy: boolean; ref?: string },
    opts: { signal?: AbortSignal } = {},
  ): Promise<void> {
    const env = getServerEnv();
    await ghVoid(
      `/repos/${env.GITHUB_REPO_OWNER}/${env.GITHUB_REPO_NAME}/actions/workflows/${BUILD_WORKFLOW_FILE}/dispatches`,
      {
        method: "POST",
        body: {
          ref: input.ref ?? DEFAULT_DEPLOY_REF,
          inputs: { force_all: input.forceAll, skip_deploy: input.skipDeploy },
        },
        signal: opts.signal,
      },
    );
  },

  // Resolve the last-deployed SHA from the `.last-built` file on the
  // `deploy-state` branch (the build workflow's marker). Returns null when the
  // branch/file doesn't exist yet (first deploy) or the content isn't a SHA.
  async getLastBuiltSha(opts: { signal?: AbortSignal } = {}): Promise<string | null> {
    const env = getServerEnv();
    try {
      const res = await ghFetch(
        `/repos/${env.GITHUB_REPO_OWNER}/${env.GITHUB_REPO_NAME}/contents/${LAST_BUILT_FILE}?ref=${DEPLOY_STATE_BRANCH}`,
        { accept: "application/vnd.github.raw", signal: opts.signal },
      );
      const text = (await res.text()).trim();
      return /^[0-9a-f]{7,40}$/i.test(text) ? text : null;
    } catch (error) {
      if (error instanceof GithubApiError && error.status === 404) return null;
      throw error;
    }
  },

  // Two-dot compare base...head → changed file paths. Used to diff the
  // last-built marker SHA against HEAD of main for drift. Throws
  // GithubApiError 404 when the base ref/SHA is missing (rewritten history).
  async compareCommits(
    base: string,
    head: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<CommitComparison> {
    const env = getServerEnv();
    const raw = await ghRequest<{
      base_commit?: { sha?: string; commit?: { committer?: { date?: string } } };
      files?: Array<{ filename?: string }>;
    }>(
      `/repos/${env.GITHUB_REPO_OWNER}/${env.GITHUB_REPO_NAME}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=100`,
      { signal: opts.signal },
    );
    return {
      baseSha: raw.base_commit?.sha ?? null,
      baseDate: raw.base_commit?.commit?.committer?.date ?? null,
      files: (raw.files ?? []).map((f) => f.filename ?? "").filter(Boolean),
    };
  },

  // Repo variable read. Returns null when unset (404). Requires the PAT's
  // Variables (read) permission.
  async getRepoVariable(
    name: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<RepoVariable | null> {
    const env = getServerEnv();
    try {
      const raw = await ghRequest<{ name: string; value: string; updated_at?: string }>(
        `/repos/${env.GITHUB_REPO_OWNER}/${env.GITHUB_REPO_NAME}/actions/variables/${name}`,
        { signal: opts.signal },
      );
      return { name: raw.name, value: raw.value, updatedAt: raw.updated_at ?? null };
    } catch (error) {
      if (error instanceof GithubApiError && error.status === 404) return null;
      throw error;
    }
  },

  // Repo variable upsert: PATCH the existing variable, or POST to create it when
  // it doesn't exist yet. Requires the PAT's Variables (write) permission.
  async setRepoVariable(
    name: string,
    value: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<void> {
    const env = getServerEnv();
    const base = `/repos/${env.GITHUB_REPO_OWNER}/${env.GITHUB_REPO_NAME}/actions/variables`;
    try {
      await ghVoid(`${base}/${name}`, { method: "PATCH", body: { name, value }, signal: opts.signal });
    } catch (error) {
      if (error instanceof GithubApiError && error.status === 404) {
        await ghVoid(base, { method: "POST", body: { name, value }, signal: opts.signal });
        return;
      }
      throw error;
    }
  },
};
