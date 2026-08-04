"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Info, Laptop, Layers, Monitor, Shuffle, TriangleAlert } from "lucide-react";
import {
  type BuildRunnerMachineKey,
  type BuildRunnerStrategy,
} from "@rop/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { useBuildRunnerVar, useSetBuildRunnerVar } from "@/hooks/use-ops-deploy";
import {
  buildRunnerSummary,
  MACHINE_LABELS,
  parseBuildRunner,
  serializeBuildRunner,
} from "@/lib/ops/build-runner";
import { toneClass } from "./tokens";

const MACHINE_META: Record<BuildRunnerMachineKey, { Icon: typeof Monitor; label: string }> = {
  "mac-mini": { Icon: Monitor, label: "mac-mini" },
  macbook: { Icon: Laptop, label: "macbook" },
};

type Draft = { strategy: BuildRunnerStrategy; machines: ReturnType<typeof parseBuildRunner>["machines"] };

function RoutingEditor() {
  const query = useBuildRunnerVar();
  const save = useSetBuildRunnerVar();
  const [draft, setDraft] = useState<Draft>(() => parseBuildRunner(""));
  const [dirty, setDirty] = useState(false);
  const initialized = useRef(false);

  useEffect(() => {
    if (query.data && !initialized.current) {
      setDraft({ strategy: query.data.strategy, machines: query.data.machines });
      initialized.current = true;
    }
  }, [query.data]);

  const update = (next: Draft) => {
    setDraft(next);
    setDirty(true);
  };
  const toggle = (key: BuildRunnerMachineKey) =>
    update({
      ...draft,
      machines: draft.machines.map((m) => (m.key === key ? { ...m, enabled: !m.enabled } : m)),
    });
  const move = (index: number, dir: -1 | 1) => {
    const next = [...draft.machines];
    const target = index + dir;
    const current = next[index];
    const swap = next[target];
    if (!current || !swap) return;
    next[index] = swap;
    next[target] = current;
    update({ ...draft, machines: next });
  };

  const isPriority = draft.strategy === "priority";
  const enabledKeys = draft.machines.filter((m) => m.enabled).map((m) => m.key);
  const none = enabledKeys.length === 0;
  const value = serializeBuildRunner(draft.strategy, draft.machines);

  if (query.isLoading) {
    return <p className="text-muted-foreground text-sm">Loading routing…</p>;
  }
  if (query.isError) {
    return (
      <p className="text-muted-foreground text-sm">
        Could not load the BUILD_RUNNER variable. The token needs the Variables permission.
      </p>
    );
  }

  return (
    <div className="grid gap-4">
      <div className="grid gap-1.5">
        <span className="text-[0.8rem] font-medium">Selection strategy</span>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={draft.strategy}
          onValueChange={(v) => v && update({ ...draft, strategy: v as BuildRunnerStrategy })}
          className="w-fit"
        >
          <ToggleGroupItem value="balanced">
            <Shuffle className="size-3.5" />
            Any free
          </ToggleGroupItem>
          <ToggleGroupItem value="priority">
            <Layers className="size-3.5" />
            Priority order
          </ToggleGroupItem>
        </ToggleGroup>
        <span className="text-muted-foreground text-xs">
          {isPriority
            ? "Dispatch tries machines top-to-bottom and lands on the first one with a free runner."
            : "Build lands on whichever selected machine has a free runner first — fastest throughput."}
        </span>
      </div>

      <div className="grid gap-1.5">
        <span className="text-[0.8rem] font-medium">
          Eligible machines{isPriority ? " · order with the arrows" : ""}
        </span>
        <div className="grid gap-1.5">
          {draft.machines.map((machine, index) => {
            const meta = MACHINE_META[machine.key];
            const rank = machine.enabled ? enabledKeys.indexOf(machine.key) + 1 : null;
            return (
              <div
                key={machine.key}
                className={cn(
                  "flex items-center gap-2.5 rounded-md border p-2.5",
                  machine.enabled ? "border-border bg-card" : "border-border bg-muted/30 opacity-70",
                )}
              >
                <Checkbox checked={machine.enabled} onCheckedChange={() => toggle(machine.key)} />
                <meta.Icon className="text-muted-foreground size-4 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-[0.82rem] font-medium">{MACHINE_LABELS[machine.key]}</div>
                  <div className="text-muted-foreground font-mono text-[10.5px]">{meta.label}</div>
                </div>
                {isPriority && machine.enabled ? (
                  <Badge variant="outline" className={cn("text-[10px]", toneClass.accent)}>
                    P{rank}
                  </Badge>
                ) : null}
                {isPriority ? (
                  <div className="flex flex-col">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                      aria-label="Higher priority"
                    >
                      <ChevronDown className="size-3 rotate-180" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      disabled={index === draft.machines.length - 1}
                      onClick={() => move(index, 1)}
                      aria-label="Lower priority"
                    >
                      <ChevronDown className="size-3" />
                    </Button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        {none ? (
          <span className="inline-flex items-center gap-1 text-xs text-[color:var(--destructive)]">
            <TriangleAlert className="size-3.5" />
            Select at least one machine.
          </span>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={!dirty || none || save.isPending}
          onClick={() => save.mutate(value, { onSuccess: () => setDirty(false) })}
        >
          {save.isPending ? "Saving…" : "Save"}
        </Button>
        <span className="text-muted-foreground text-sm">
          Resolves to{" "}
          <strong className="text-foreground font-medium">
            {buildRunnerSummary(draft.strategy, draft.machines)}
          </strong>
        </span>
      </div>

      <div className="text-muted-foreground bg-muted/45 grid gap-0.5 rounded-md p-2.5 font-mono text-[0.72rem]">
        <span>
          vars.BUILD_RUNNER = &quot;{value || "—"}&quot;
          {isPriority && enabledKeys.length > 1 ? '   # ">" = priority order' : ""}
        </span>
        <span>{"runs-on: [self-hosted, mac, ${{ vars.BUILD_RUNNER }}]"}</span>
      </div>

      <div className="text-muted-foreground flex items-start gap-2 text-[0.78rem]">
        <Info className="mt-0.5 size-3.5 shrink-0" />
        <span>
          Writes the <code className="bg-muted rounded px-1 font-mono">BUILD_RUNNER</code> repo
          variable. <strong>Not wired into build-images.yml yet</strong> — saving has no effect until
          the workflow reads the variable and each runner carries a per-machine label
          (<code className="bg-muted rounded px-1 font-mono">mac-mini</code> /{" "}
          <code className="bg-muted rounded px-1 font-mono">macbook</code>). Pin a single machine to
          drain the others for maintenance.
        </span>
      </div>
    </div>
  );
}

export function BuildRoutingCard() {
  const [open, setOpen] = useState(false);
  const query = useBuildRunnerVar();
  const summary = query.data
    ? buildRunnerSummary(query.data.strategy, query.data.machines)
    : "Any free Mac";

  return (
    <Card className="py-0">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <button className="hover:bg-muted/30 flex w-full items-center justify-between gap-2 rounded-xl px-4 py-4 text-left transition-colors">
            <div className="grid gap-0.5">
              <div className="flex items-center gap-2">
                <Shuffle className="text-muted-foreground size-4" />
                <span className="text-base font-medium">Build routing</span>
                <Badge variant="outline" className={toneClass.muted}>
                  optional
                </Badge>
              </div>
              <span className="text-muted-foreground text-sm">
                Pin builds to a machine for maintenance, or leave on auto.
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground bg-muted rounded-full px-2 py-0.5 font-mono text-[10.5px]">
                {summary}
              </span>
              <ChevronDown
                className={cn("text-muted-foreground size-4 transition-transform", open && "rotate-180")}
              />
            </div>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t px-4 py-4">
            <RoutingEditor />
          </div>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
