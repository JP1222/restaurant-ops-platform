import { CircleCheck, ExternalLink, Loader2, Tag, TriangleAlert } from "lucide-react";
import type { OpsFreshnessResponse } from "@rop/contracts";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { WorkflowRunSummary } from "@/lib/github";
import { RelativeTime } from "@/components/ops/relative-time";
import { toneClass } from "./tokens";

// Two mutually-exclusive states:
//  - a build is in progress  → concurrency lock (deploys are serialized)
//  - idle                    → freshness / drift since the last-built marker
export function StatusStrip({
  activeBuild,
  fresh,
}: {
  activeBuild: WorkflowRunSummary | null;
  fresh: OpsFreshnessResponse | undefined;
}) {
  if (activeBuild) {
    return (
      <Card className="py-3">
        <CardContent className="flex flex-col gap-2 px-4">
          <div className="flex flex-wrap items-center gap-2">
            <Loader2 className="text-muted-foreground size-4 animate-spin" />
            <span className="font-medium">Build #{activeBuild.runNumber} running</span>
            <Badge variant="outline" className={cn("text-[10px] uppercase", toneClass.blue)}>
              in progress
            </Badge>
            {activeBuild.headSha ? (
              <span className="text-muted-foreground font-mono text-[11px]">
                {activeBuild.headSha.slice(0, 7)}
              </span>
            ) : null}
            <a
              href={activeBuild.htmlUrl}
              target="_blank"
              rel="noreferrer"
              className="text-[color:var(--accent)] ml-auto inline-flex items-center gap-1 text-sm hover:underline"
            >
              <ExternalLink className="size-3" />
              View
            </a>
          </div>
          <p className="text-muted-foreground text-xs">
            Deploys are serialized — the Deploy button unlocks when this finishes.
          </p>
        </CardContent>
      </Card>
    );
  }

  const drift = fresh?.drift ?? [];
  const unknown = fresh?.comparedAgainst === "none";
  const clean = !unknown && drift.length === 0;

  return (
    <Card className="py-3">
      <CardContent className="flex flex-wrap items-center gap-2 px-4">
        {clean ? (
          <CircleCheck className="size-4 shrink-0 text-[color:var(--accent)]" />
        ) : (
          <TriangleAlert className="size-4 shrink-0 text-[color:var(--chart-4)]" />
        )}
        <span className="text-sm font-medium">
          {unknown
            ? "Drift unknown — no last-built marker yet"
            : clean
              ? "All apps up to date"
              : `${drift.length} app${drift.length === 1 ? "" : "s"} changed since last deploy`}
        </span>
        {drift.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {drift.map((app) => (
              <span
                key={app}
                className="text-muted-foreground bg-muted rounded-full px-1.5 py-0.5 font-mono text-[10px]"
              >
                {app}
              </span>
            ))}
          </div>
        ) : null}
        <span className="text-muted-foreground ml-auto inline-flex items-center gap-1.5 text-xs">
          <Tag className="size-3" />
          {fresh?.lastSha ? (
            <>
              last-built <code className="bg-muted rounded px-1 font-mono">{fresh.lastSha}</code> ·{" "}
              <RelativeTime iso={fresh.lastBuiltAt} />
            </>
          ) : (
            "no last-built marker"
          )}
        </span>
      </CardContent>
    </Card>
  );
}
