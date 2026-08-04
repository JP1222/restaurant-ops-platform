"use client";

import { useMemo } from "react";
import { opsBuildApps, type OpsBuildApp } from "@rop/contracts";
import type { WorkflowJob, WorkflowRunSummary } from "@/lib/github";
import type { PipelineImagesResponse, PipelineServicesResponse } from "@/hooks/use-pipeline";
import { RelativeTime } from "./relative-time";
import { cn } from "@/lib/utils";

// opsBuildApps (contracts) is the single source of truth for WHICH apps the
// pipeline builds; this map only assigns each a UI label. Adding an app to the
// build matrix surfaces it here automatically — and a missing label is a
// compile error (Record over the full OpsBuildApp union).
const APP_LABELS: Record<OpsBuildApp, string> = {
  "kds-api": "KDS API",
  "kds-web": "KDS Web",
  "analytics-api": "Analytics",
  "backoffice-web": "Backoffice",
  "legal-site": "Legal Site",
  "marketing-site": "Marketing",
  "crew-web": "Crew Web",
  "inventory-api": "Inventory",
  "order-web": "Order Web",
  "crm-api": "CRM",
};

const APPS = opsBuildApps.map((key) => ({ key, label: APP_LABELS[key] }));

type StageState = "idle" | "queued" | "running" | "success" | "failed" | "skipped";

interface AppRow {
  app: (typeof APPS)[number];
  build: { state: StageState; durationSec: number | null; jobUrl: string | null };
  image: { state: StageState; tagSha: string | null; pushedAt: string | null; htmlUrl: string | null };
  container: { state: StageState; latencyMs: number | null; httpStatus: number | null };
}

interface PipelineFlowProps {
  buildRun: WorkflowRunSummary | null;
  buildJobs: WorkflowJob[];
  ciRun: WorkflowRunSummary | null;
  images: PipelineImagesResponse | null;
  services: PipelineServicesResponse | null;
}

function classifyConclusion(status: string, conclusion: string | null): StageState {
  if (status === "queued") return "queued";
  if (status === "in_progress" || status === "pending" || status === "waiting") return "running";
  if (status !== "completed") return "running";
  if (conclusion === "success") return "success";
  if (conclusion === "skipped") return "skipped";
  if (conclusion === "cancelled" || conclusion === "neutral" || conclusion === "stale")
    return "skipped";
  return "failed";
}

function deriveRows(props: PipelineFlowProps): AppRow[] {
  const { buildJobs, images, services } = props;
  return APPS.map((app) => {
    const buildJob = buildJobs.find((j) => j.name === `Build ${app.key} (arm64)`);
    let buildState: StageState = "idle";
    let durationSec: number | null = null;
    let jobUrl: string | null = null;
    if (buildJob) {
      buildState = classifyConclusion(buildJob.status, buildJob.conclusion);
      jobUrl = buildJob.htmlUrl;
      if (buildJob.startedAt && buildJob.completedAt) {
        durationSec = Math.max(
          0,
          Math.round(
            (new Date(buildJob.completedAt).getTime() - new Date(buildJob.startedAt).getTime()) /
              1000,
          ),
        );
      } else if (buildJob.startedAt) {
        durationSec = Math.max(
          0,
          Math.round((Date.now() - new Date(buildJob.startedAt).getTime()) / 1000),
        );
      }
    }

    const imageInfo = images?.images.find((i) => i.app === app.key);
    let imageState: StageState = "idle";
    let tagSha: string | null = null;
    let pushedAt: string | null = null;
    let imageHtmlUrl: string | null = null;
    if (imageInfo?.mainTag) {
      // Image present means GHCR push succeeded. If a more recent build is in
      // flight, classify as "running" only when we see the build still going;
      // otherwise this stage is "success".
      const buildInFlight = buildState === "running" || buildState === "queued";
      imageState = buildInFlight ? "running" : "success";
      tagSha = imageInfo.mainTag.name;
      pushedAt = imageInfo.mainTag.updatedAt;
      imageHtmlUrl = imageInfo.mainTag.htmlUrl;
    } else if (imageInfo?.error) {
      imageState = "skipped";
    }

    const svc = services?.services.find((s) => s.app === app.key);
    let containerState: StageState = "idle";
    let latencyMs: number | null = null;
    let httpStatus: number | null = null;
    if (svc) {
      containerState = svc.status === "healthy" ? "success" : "failed";
      latencyMs = svc.latencyMs;
      httpStatus = svc.httpStatus;
    }

    return {
      app,
      build: { state: buildState, durationSec, jobUrl },
      image: {
        state: imageState,
        tagSha: tagSha?.slice(0, 12) ?? null,
        pushedAt,
        htmlUrl: imageHtmlUrl,
      },
      container: { state: containerState, latencyMs, httpStatus },
    };
  });
}

const STATE_STYLES: Record<StageState, string> = {
  idle: "border-border bg-muted/30 text-muted-foreground",
  queued:
    "border-dashed border-muted-foreground/30 bg-muted/40 text-muted-foreground",
  running:
    "border-[color:var(--chart-3)]/50 bg-[color:var(--chart-3)]/10 text-foreground shadow-[0_0_0_3px_color-mix(in_oklab,var(--chart-3)_15%,transparent)] animate-pulse",
  success: "border-[color:var(--accent)]/40 bg-[color:var(--accent)]/10 text-foreground",
  failed:
    "border-[color:var(--destructive)]/50 bg-[color:var(--destructive)]/10 text-foreground",
  skipped: "border-border bg-muted/20 text-muted-foreground",
};

const STATE_DOT: Record<StageState, string> = {
  idle: "bg-muted-foreground/40",
  queued: "bg-muted-foreground/40 animate-pulse",
  running: "bg-[color:var(--chart-3)] animate-pulse",
  success: "bg-[color:var(--accent)]",
  failed: "bg-[color:var(--destructive)]",
  skipped: "bg-muted-foreground/30",
};

function StageNode({
  state,
  title,
  subtitle,
  meta,
  href,
}: {
  state: StageState;
  title: string;
  subtitle?: string | null;
  meta?: string | null;
  href?: string | null;
}) {
  const inner = (
    <div
      className={cn(
        "relative h-full rounded-lg border px-3 py-2.5 text-left transition-colors",
        STATE_STYLES[state],
        href && "hover:border-foreground/40",
      )}
    >
      <div className="flex items-center gap-2">
        <span className={cn("size-1.5 shrink-0 rounded-full", STATE_DOT[state])} />
        <span className="truncate text-xs font-medium tracking-tight">{title}</span>
      </div>
      {subtitle ? (
        <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{subtitle}</p>
      ) : null}
      {meta ? (
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground/80">{meta}</p>
      ) : null}
    </div>
  );
  if (!href) return inner;
  return (
    <a href={href} target="_blank" rel="noreferrer" className="block h-full">
      {inner}
    </a>
  );
}

function Chevron({ state }: { state: StageState }) {
  // Use a single horizontal stroke + small ▶ for the inter-stage arrow. Color
  // it by the downstream node so the visual signal flows "into" the stage.
  const color =
    state === "running"
      ? "text-[color:var(--chart-3)]"
      : state === "success"
        ? "text-[color:var(--accent)]"
        : state === "failed"
          ? "text-[color:var(--destructive)]"
          : "text-muted-foreground/40";
  return (
    <div className={cn("flex h-full items-center justify-center", color)} aria-hidden>
      <svg width="22" height="10" viewBox="0 0 22 10" fill="none">
        <line x1="0" y1="5" x2="16" y2="5" stroke="currentColor" strokeWidth="1.5" />
        <path d="M16 1 L21 5 L16 9" stroke="currentColor" strokeWidth="1.5" fill="none" />
      </svg>
    </div>
  );
}

export function PipelineFlow(props: PipelineFlowProps) {
  const { buildRun, ciRun } = props;
  const rows = useMemo(() => deriveRows(props), [props]);

  const pushState: StageState = buildRun ? "success" : "idle";
  const pushSubtitle = buildRun ? buildRun.headSha.slice(0, 8) : null;
  const pushMeta = buildRun?.actorLogin ? `@${buildRun.actorLogin}` : null;
  const ciState: StageState = ciRun
    ? classifyConclusion(ciRun.status, ciRun.conclusion)
    : "idle";
  const ciSubtitle = ciRun ? ciRun.headBranch ?? "" : null;

  // CI duration when known
  const ciDuration =
    ciRun?.runStartedAt && ciRun?.updatedAt && ciRun.status === "completed"
      ? `${Math.round((new Date(ciRun.updatedAt).getTime() - new Date(ciRun.runStartedAt).getTime()) / 1000)}s`
      : ciRun?.status === "in_progress"
        ? "running…"
        : null;

  return (
    <div className="rounded-xl border bg-card p-4 lg:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2 pb-3">
        <div>
          <h3 className="text-sm font-medium tracking-tight">Live pipeline</h3>
          <p className="text-xs text-muted-foreground">
            Latest <span className="font-mono">main</span> push → CI → arm64 build → GHCR → Oracle container
          </p>
        </div>
        {buildRun ? (
          <a
            href={buildRun.htmlUrl}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[11px] text-muted-foreground hover:text-foreground"
          >
            run #{buildRun.runNumber} •&nbsp;<RelativeTime iso={buildRun.runStartedAt} />
          </a>
        ) : null}
      </div>

      <div
        className="grid items-stretch gap-x-3 gap-y-2"
        style={{
          gridTemplateColumns:
            "minmax(140px,1.2fr) 28px minmax(140px,1.2fr) 28px minmax(160px,1.6fr) 28px minmax(170px,1.7fr) 28px minmax(150px,1.5fr)",
        }}
      >
        {/* Header row — stage labels */}
        <StageHeader>Push</StageHeader>
        <div />
        <StageHeader>CI gate</StageHeader>
        <div />
        <StageHeader>Build (Mac Mini)</StageHeader>
        <div />
        <StageHeader>GHCR image</StageHeader>
        <div />
        <StageHeader>Container</StageHeader>

        {/* Shared Push + CI nodes span every app row via a single tall node.
            Inline gridRow (not Tailwind row-span-N) so it scales to any app
            count — row-span-10 isn't in the default Tailwind scale. */}
        <div className="self-stretch" style={{ gridRow: `span ${APPS.length}` }}>
          <StageNode
            state={pushState}
            title={buildRun?.displayTitle?.slice(0, 32) ?? "no recent push"}
            subtitle={pushSubtitle}
            meta={pushMeta}
            href={buildRun ? buildRun.htmlUrl : null}
          />
        </div>
        <div style={{ gridRow: `span ${APPS.length}` }}>
          <Chevron state={ciState} />
        </div>
        <div className="self-stretch" style={{ gridRow: `span ${APPS.length}` }}>
          <StageNode
            state={ciState}
            title="CI: lint+build+test"
            subtitle={ciSubtitle}
            meta={ciDuration}
            href={ciRun ? ciRun.htmlUrl : null}
          />
        </div>

        {/* Per-app rows: chevron + build + chevron + image + chevron + container */}
        {rows.map((row) => (
          <PerAppRow key={row.app.key} row={row} />
        ))}
      </div>
    </div>
  );
}

function PerAppRow({ row }: { row: AppRow }) {
  return (
    <>
      <div className="self-center">
        <Chevron state={row.build.state} />
      </div>
      <StageNode
        state={row.build.state}
        title={row.app.label}
        subtitle={row.build.state === "idle" ? "no recent build" : null}
        meta={
          row.build.durationSec != null ? `${row.build.durationSec}s` : null
        }
        href={row.build.jobUrl}
      />
      <div className="self-center">
        <Chevron state={row.image.state} />
      </div>
      <StageNode
        state={row.image.state}
        title="ghcr.io"
        subtitle={row.image.tagSha ? row.image.tagSha : "no image"}
        meta={row.image.pushedAt ? `pushed ` : null}
        href={row.image.htmlUrl}
      />
      <div className="self-center">
        <Chevron state={row.container.state} />
      </div>
      <StageNode
        state={row.container.state}
        title="oracle"
        subtitle={
          row.container.httpStatus != null
            ? `HTTP ${row.container.httpStatus}`
            : row.container.state === "idle"
              ? "no probe"
              : "unreachable"
        }
        meta={row.container.latencyMs != null ? `${row.container.latencyMs}ms` : null}
      />
    </>
  );
}

function StageHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
      {children}
    </div>
  );
}
