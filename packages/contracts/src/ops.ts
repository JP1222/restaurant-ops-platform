import { z } from "zod";

// ── Operations panel (CI/CD status + one-click Deploy) ──────────────────────
// DTOs for the backoffice-web Operations page. The BFF (`app/api/ops/*`) is the
// only thing that talks to GitHub; these shapes cross the BFF→browser boundary.
// See apps/backoffice-web/components/ops/operations/.

// The 10 deployable apps, in the same order build-images.yml builds them.
export const opsBuildApps = [
  "kds-api",
  "kds-web",
  "analytics-api",
  "backoffice-web",
  "legal-site",
  "marketing-site",
  "crew-web",
  "inventory-api",
  "order-web",
  "crm-api"
] as const;
export const OpsBuildAppSchema = z.enum(opsBuildApps);
export type OpsBuildApp = z.infer<typeof OpsBuildAppSchema>;

// ── Runners (read-only) ─────────────────────────────────────────────────────
// Sourced from GitHub `GET /repos/{owner}/{repo}/actions/runners`. The runners
// API does not return disk/cache/last-active — those design elements are
// deferred until a metric agent exists. `currentJob` is best-effort: when a
// runner is busy we correlate the in-progress run's jobs by runner name.
export const OpsRunnerStatusSchema = z.enum(["online", "offline"]);
export type OpsRunnerStatus = z.infer<typeof OpsRunnerStatusSchema>;

export const OpsRunnerSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  status: OpsRunnerStatusSchema,
  busy: z.boolean(),
  os: z.string().nullable(),
  labels: z.array(z.string()),
  currentJob: z.string().nullable()
});
export type OpsRunner = z.infer<typeof OpsRunnerSchema>;

export const OpsRunnersResponseSchema = z.object({
  runners: z.array(OpsRunnerSchema),
  online: z.number().int().min(0),
  total: z.number().int().min(0),
  busy: z.number().int().min(0)
});
export type OpsRunnersResponse = z.infer<typeof OpsRunnersResponseSchema>;

// ── Deploy (the action) ─────────────────────────────────────────────────────
// POST /api/ops/deploy → workflow_dispatch on build-images.yml.
//   mode "force_all"  → inputs.force_all = true
//   skipDeploy        → inputs.skip_deploy = true
//   ref is always "main" (deploy source-of-truth, per ADR-0014).
export const DeployModeSchema = z.enum(["incremental", "force_all"]);
export type DeployMode = z.infer<typeof DeployModeSchema>;

export const DeployRequestSchema = z.object({
  mode: DeployModeSchema,
  skipDeploy: z.boolean().default(false)
});
export type DeployRequest = z.infer<typeof DeployRequestSchema>;

// The dispatch endpoint returns 204 with no run id; the BFF resolves the newly
// created run by listing recent build-images.yml runs. `runId`/`htmlUrl` are
// null when the run has not surfaced yet — the client then polls runs to find it.
export const DeployDispatchResponseSchema = z.object({
  ok: z.literal(true),
  runId: z.number().int().nullable(),
  htmlUrl: z.string().nullable()
});
export type DeployDispatchResponse = z.infer<typeof DeployDispatchResponseSchema>;

// ── Freshness / drift ───────────────────────────────────────────────────────
// Drives the status strip + Images "stale" badges. Compares the `last-built`
// git tag against HEAD of main (same base the workflow's paths-filter uses) and
// maps changed files to affected apps via lib/ops/app-paths.ts.
export const OpsFreshnessResponseSchema = z.object({
  lastSha: z.string().nullable(),
  lastBuiltAt: z.string().nullable(),
  head: z.string().nullable(),
  drift: z.array(z.string()),
  // "last-built" when the tag resolved and a real diff ran; "none" when the tag
  // is missing (first deploy / rewritten history) and drift can't be computed.
  comparedAgainst: z.enum(["last-built", "none"])
});
export type OpsFreshnessResponse = z.infer<typeof OpsFreshnessResponseSchema>;

// ── Build routing (optional) ────────────────────────────────────────────────
// Reads/writes the `BUILD_RUNNER` repo variable. Serialized value is
// "mac-mini,macbook" (balanced) or "macbook>mac-mini" (priority, ">" = order).
// parse/serialize live in apps/backoffice-web/lib/ops/build-runner.ts so the
// route and the component agree on the encoding.
export const buildRunnerMachineKeys = ["mac-mini", "macbook"] as const;
export const BuildRunnerMachineKeySchema = z.enum(buildRunnerMachineKeys);
export type BuildRunnerMachineKey = z.infer<typeof BuildRunnerMachineKeySchema>;

export const BuildRunnerStrategySchema = z.enum(["balanced", "priority"]);
export type BuildRunnerStrategy = z.infer<typeof BuildRunnerStrategySchema>;

export const BuildRunnerMachineSchema = z.object({
  key: BuildRunnerMachineKeySchema,
  enabled: z.boolean()
});
export type BuildRunnerMachine = z.infer<typeof BuildRunnerMachineSchema>;

export const BuildRunnerVarSchema = z.object({
  exists: z.boolean(),
  value: z.string(),
  strategy: BuildRunnerStrategySchema,
  machines: z.array(BuildRunnerMachineSchema)
});
export type BuildRunnerVar = z.infer<typeof BuildRunnerVarSchema>;

export const BuildRunnerUpdateRequestSchema = z.object({
  value: z.string().max(200)
});
export type BuildRunnerUpdateRequest = z.infer<typeof BuildRunnerUpdateRequestSchema>;

// ── Historical backfill control (operator requeue / unblock) ────────────────
// POST /api/ops/backfill → analytics-api POST /admin/api/backfill/requeue.
// The action only RESETS terminal window state (failed/blocked → pending) so the
// autonomous scheduler reprocesses those windows one-at-a-time within the export
// window — it never bypasses the single-active-job / rate-limit guards. Completed
// windows are never touched; "missing" (not-started) windows are already picked
// up by the scheduler, so this surface targets failed/blocked rows.
//   retry_failed_and_missing → reset status IN ('failed','blocked')
//   unblock                  → reset status = 'blocked' only
// windowStart/windowEnd are an optional inclusive ISO range; null = all windows.
export const backfillRequeueActions = ["retry_failed_and_missing", "unblock"] as const;
export const BackfillRequeueActionSchema = z.enum(backfillRequeueActions);
export type BackfillRequeueAction = z.infer<typeof BackfillRequeueActionSchema>;

export const BackfillRequeueRequestSchema = z
  .object({
    action: BackfillRequeueActionSchema,
    windowStart: z.string().datetime().nullable().default(null),
    windowEnd: z.string().datetime().nullable().default(null)
  })
  .refine(
    (value) =>
      !value.windowStart ||
      !value.windowEnd ||
      new Date(value.windowStart).getTime() <= new Date(value.windowEnd).getTime(),
    { message: "windowStart must be <= windowEnd", path: ["windowStart"] }
  );
export type BackfillRequeueRequest = z.infer<typeof BackfillRequeueRequestSchema>;

export const BackfillRequeueResponseSchema = z.object({
  ok: z.literal(true),
  action: BackfillRequeueActionSchema,
  requeuedWindows: z.number().int().min(0)
});
export type BackfillRequeueResponse = z.infer<typeof BackfillRequeueResponseSchema>;
