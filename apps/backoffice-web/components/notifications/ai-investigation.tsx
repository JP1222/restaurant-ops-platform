"use client";

import { Check, CircleCheckBig, Info, Sparkles, TrendingDown, TrendingUp, WandSparkles } from "lucide-react";
import { Bar, BarChart, Cell, LabelList, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import { ChartContainer } from "@/components/ui/chart";
import type {
  ActionBlock,
  AiBlock,
  AiInvestigation,
  BarsBlock,
  BlockTone,
  CompareBlock,
  MetricBlock,
  Severity,
  StepsBlock,
} from "@/lib/notifications/types";
import { useNotificationStore } from "@/stores/notifications";
import { NotifIcon } from "./notif-icon";

function emphasisColor(severity: Severity): string {
  if (severity === "crit") return "var(--destructive)";
  if (severity === "warn") return "var(--warn)";
  return "var(--accent)";
}

function toneColor(tone: BlockTone): string {
  if (tone === "crit") return "var(--destructive)";
  if (tone === "warn") return "var(--warn)";
  if (tone === "accent") return "var(--accent)";
  return "var(--muted-foreground)";
}

export function AiInvestigation({
  id,
  severity,
  investigation,
}: {
  id: string;
  severity: Severity;
  investigation: AiInvestigation;
}) {
  return (
    <div className="mt-3 rounded-[10px] border border-accent/25 bg-accent-soft p-3 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-1 motion-safe:duration-150">
      <div className="flex items-center gap-1.5 text-[11.5px] font-semibold text-accent">
        <Sparkles className="size-3.5" /> AI investigation · traceable
      </div>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-pretty text-foreground">
        {investigation.text}
      </p>
      {investigation.block ? (
        <BlockCard id={id} severity={severity} block={investigation.block} />
      ) : null}
    </div>
  );
}

function BlockCard({ id, severity, block }: { id: string; severity: Severity; block: AiBlock }) {
  return (
    <div className="mt-2.5 rounded-[9px] border border-border bg-card p-3">
      <div className="mb-2.5 inline-flex items-center gap-1.5 rounded-[5px] bg-accent-soft px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-accent uppercase">
        <WandSparkles className="size-3" />
        {block.label}
      </div>
      {block.kind === "bars" ? <BarsViz block={block} severity={severity} /> : null}
      {block.kind === "compare" ? <CompareViz block={block} /> : null}
      {block.kind === "steps" ? <StepsViz block={block} /> : null}
      {block.kind === "metric" ? <MetricViz block={block} /> : null}
      {block.kind === "action" ? <ActionViz id={id} block={block} /> : null}
    </div>
  );
}

function Caption({ text }: { text: string }) {
  return (
    <div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <Info className="size-3" />
      {text}
    </div>
  );
}

function BarsViz({ block, severity }: { block: BarsBlock; severity: Severity }) {
  const emphasis = emphasisColor(severity);
  const data = block.cols.map((c) => ({ ...c }));
  return (
    <>
      <div className="text-[11.5px] font-semibold text-foreground">{block.title}</div>
      <ChartContainer config={{}} className="mt-1.5 aspect-auto h-24 w-full">
        <BarChart data={data} margin={{ top: 16, right: 4, bottom: 0, left: 4 }}>
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            tickMargin={6}
            tick={{ fontSize: 9.5 }}
          />
          <YAxis hide domain={[0, 1.15]} />
          <Bar dataKey="ratio" radius={[4, 4, 0, 0]} isAnimationActive={false}>
            <LabelList
              dataKey="value"
              position="top"
              offset={6}
              fill="var(--muted-foreground)"
              fontSize={10}
              className="font-mono tabular-nums"
            />
            {data.map((d, i) => (
              <Cell key={i} fill={d.emphasis ? emphasis : "var(--muted-foreground)"} />
            ))}
          </Bar>
        </BarChart>
      </ChartContainer>
      <Caption text={block.caption} />
    </>
  );
}

function CompareViz({ block }: { block: CompareBlock }) {
  return (
    <>
      <div className="text-[11.5px] font-semibold text-foreground">{block.title}</div>
      <div className="mt-2.5 flex flex-col gap-2">
        {block.rows.map((r) => (
          <div key={r.label} className="flex items-center gap-2">
            <span className="w-[50px] shrink-0 text-[11px] text-muted-foreground">{r.label}</span>
            <div className="h-3 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full"
                style={{ width: `${Math.round(r.ratio * 100)}%`, background: toneColor(r.tone) }}
              />
            </div>
            <span className="w-[38px] shrink-0 text-right font-mono text-[11px] font-semibold text-foreground tabular-nums">
              {r.value}
            </span>
          </div>
        ))}
      </div>
      <Caption text={block.caption} />
    </>
  );
}

function StepsViz({ block }: { block: StepsBlock }) {
  return (
    <>
      <div className="text-[11.5px] font-semibold text-foreground">{block.title}</div>
      <div className="mt-2.5 flex flex-col gap-2">
        {block.items.map((item, i) => (
          <div key={i} className="flex items-start gap-2.5">
            <span className="mt-px inline-flex size-[18px] shrink-0 items-center justify-center rounded-full bg-accent-soft text-[10px] font-bold text-accent tabular-nums">
              {i + 1}
            </span>
            <span className="text-xs leading-snug text-foreground">{item.text}</span>
          </div>
        ))}
      </div>
    </>
  );
}

function MetricViz({ block }: { block: MetricBlock }) {
  const up = block.deltaTone === "up";
  const DeltaIcon = up ? TrendingUp : TrendingDown;
  return (
    <>
      <div className="flex items-baseline gap-1.5">
        <span
          className={`text-3xl font-semibold tracking-tight tabular-nums ${up ? "text-trend-up" : "text-trend-down"}`}
        >
          {block.value}
        </span>
        <span className="font-mono text-xs font-semibold text-muted-foreground">{block.unit}</span>
      </div>
      <div className="mt-px text-xs text-foreground">{block.metricLabel}</div>
      <div className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <DeltaIcon className={`size-3 ${up ? "text-trend-up" : "text-trend-down"}`} />
        {block.delta}
      </div>
    </>
  );
}

function ActionViz({ id, block }: { id: string; block: ActionBlock }) {
  const confirmingId = useNotificationStore((s) => s.confirmingActionId);
  const applied = useNotificationStore((s) => s.appliedActionIds.includes(id));
  const startConfirm = useNotificationStore((s) => s.startConfirm);
  const cancelConfirm = useNotificationStore((s) => s.cancelConfirm);
  const applyAction = useNotificationStore((s) => s.applyAction);
  const confirming = confirmingId === id && !applied;

  return (
    <div className="flex items-start gap-3">
      <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
        <NotifIcon name={block.icon} className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-semibold text-foreground">{block.title}</div>
        <div className="mt-0.5 text-[11.5px] leading-snug text-muted-foreground">{block.hint}</div>

        {!applied && !confirming ? (
          <Button size="sm" className="mt-2.5 h-7 gap-1.5 px-3 text-xs" onClick={() => startConfirm(id)}>
            <Check className="size-3.5" /> {block.action.applyLabel}
          </Button>
        ) : null}

        {confirming ? (
          <div className="mt-2.5">
            <div className="mb-1.5 text-[11px] text-muted-foreground">{block.action.confirmPrompt}</div>
            <div className="flex gap-2">
              <Button size="sm" className="h-7 gap-1.5 px-3 text-xs" onClick={() => applyAction(id)}>
                <Check className="size-3.5" /> Confirm
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-3 text-xs"
                onClick={() => cancelConfirm()}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : null}

        {applied ? (
          <div className="mt-2.5 inline-flex items-center gap-1.5 text-[11.5px] font-medium text-trend-up">
            <CircleCheckBig className="size-3.5" /> {block.action.doneLabel}
          </div>
        ) : null}
      </div>
    </div>
  );
}
