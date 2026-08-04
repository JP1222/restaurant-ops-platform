import { Cpu, Laptop, Loader2, Monitor, Server } from "lucide-react";
import type { OpsRunner, OpsRunnersResponse } from "@rop/contracts";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { toneClass, type Tone } from "./tokens";

function StatusDot({ tone, pulse }: { tone: Tone; pulse?: boolean }) {
  const bg =
    tone === "accent"
      ? "bg-[color:var(--accent)]"
      : tone === "blue"
        ? "bg-[color:var(--chart-3)]"
        : "bg-muted-foreground";
  return <span className={cn("size-2 shrink-0 rounded-full", bg, pulse && "animate-pulse")} />;
}

function RunnerStatusPill({ runner }: { runner: OpsRunner }) {
  const [tone, label, pulse]: [Tone, string, boolean] =
    runner.status === "offline"
      ? ["muted", "offline", false]
      : runner.busy
        ? ["blue", "busy", true]
        : ["accent", "idle", false];
  return (
    <Badge variant="outline" className={cn("gap-1", toneClass[tone])}>
      <StatusDot tone={tone} pulse={pulse} />
      {label}
    </Badge>
  );
}

function RunnerCard({ runner }: { runner: OpsRunner }) {
  const isMacbook = runner.labels.some((l) => l.toLowerCase().includes("macbook"));
  const Icon = isMacbook ? Laptop : Monitor;
  const arch = runner.labels.find((l) => /^(arm64|x64|x86_64)$/i.test(l));
  const offline = runner.status === "offline";

  return (
    <div
      className={cn(
        "border-border bg-card flex flex-col gap-2 rounded-lg border p-3",
        offline && "opacity-60",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className="text-muted-foreground size-4 shrink-0" />
          <span className="truncate font-mono text-[0.82rem] font-semibold">{runner.name}</span>
        </div>
        <RunnerStatusPill runner={runner} />
      </div>
      <div className="flex flex-wrap gap-1">
        {runner.labels.map((label) => (
          <span
            key={label}
            className="text-muted-foreground bg-muted rounded-full px-1.5 py-0.5 font-mono text-[10.5px]"
          >
            {label}
          </span>
        ))}
      </div>
      {runner.os || arch ? (
        <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <Cpu className="size-3 shrink-0" />
          {[runner.os, arch].filter(Boolean).join(" · ")}
        </div>
      ) : null}
      {runner.currentJob ? (
        <div className={cn("flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs", toneClass.blue)}>
          <Loader2 className="size-3 shrink-0 animate-spin" />
          <span className="truncate font-mono">{runner.currentJob}</span>
        </div>
      ) : null}
    </div>
  );
}

export function RunnersCard({
  data,
  isLoading,
  isError,
}: {
  data: OpsRunnersResponse | undefined;
  isLoading: boolean;
  isError: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base font-medium">
          <Server className="text-muted-foreground size-4" />
          Runners
        </CardTitle>
        <CardDescription>
          Self-hosted Mac pool. Read-only — registered via each machine&apos;s svc.sh.
        </CardDescription>
        {data ? (
          <CardAction>
            <Badge variant="outline" className={toneClass.muted}>
              {data.online}/{data.total} online
            </Badge>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-2.5">
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
          </div>
        ) : isError || !data ? (
          <p className="text-muted-foreground text-sm">
            Could not load runners. Check that the GitHub token has the{" "}
            <code className="bg-muted rounded px-1 font-mono text-xs">administration:read</code> scope.
          </p>
        ) : data.runners.length === 0 ? (
          <p className="text-muted-foreground text-sm">No self-hosted runners registered.</p>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-2.5">
            {data.runners.map((runner) => (
              <RunnerCard key={runner.id} runner={runner} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
