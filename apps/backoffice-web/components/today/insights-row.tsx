"use client";

import type { ComponentType } from "react";
import { AlertOctagon, AlertTriangle, MessageSquare, Sparkles, TrendingUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { Insight, InsightsResponse } from "@rop/contracts";
import { cn } from "@/lib/utils";
import { useAiAssistantStore } from "@/stores/ai-assistant";

const SEVERITY_META: Record<
  Insight["severity"],
  {
    label: string;
    borderClass: string;
    iconClass: string;
    Icon: ComponentType<{ className?: string }>;
  }
> = {
  critical: {
    label: "Critical",
    borderClass: "border-l-4 border-l-[color:var(--destructive)]",
    iconClass: "text-[color:var(--destructive)]",
    Icon: AlertOctagon,
  },
  warning: {
    label: "Warning",
    borderClass: "border-l-4 border-l-[color:var(--chart-4)]",
    iconClass: "text-[color:var(--chart-4)]",
    Icon: AlertTriangle,
  },
  info: {
    label: "Info",
    borderClass: "border-l-4 border-l-[color:var(--chart-3)]",
    iconClass: "text-[color:var(--chart-3)]",
    Icon: Sparkles,
  },
  positive: {
    label: "Positive",
    borderClass: "border-l-4 border-l-[color:var(--accent)]",
    iconClass: "text-[color:var(--accent)]",
    Icon: TrendingUp,
  },
};

function InsightCard({ insight }: { insight: Insight }) {
  const open = useAiAssistantStore((state) => state.open);
  const meta = SEVERITY_META[insight.severity];
  const Icon = meta.Icon;

  return (
    <Card className={meta.borderClass}>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="flex min-w-0 items-start gap-2 text-base font-medium">
            <Icon className={cn("mt-0.5 size-5 shrink-0", meta.iconClass)} />
            <span>{insight.title}</span>
          </CardTitle>
          <Badge variant="secondary" className="shrink-0">
            {meta.label}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-muted-foreground text-sm">{insight.detail}</p>
        <Button
          variant="ghost"
          size="sm"
          className="text-accent hover:bg-accent/10 hover:text-accent w-fit"
          onClick={() => open({ prompt: insight.ask_ai_prompt, source: "insight" })}
        >
          <MessageSquare data-icon="inline-start" />
          Ask AI
        </Button>
      </CardContent>
    </Card>
  );
}

export function InsightsRow({ data }: { data: InsightsResponse }) {
  if (data.all_clear) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base font-medium">
            <Sparkles className="text-accent size-5" />
            Everything looks normal
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            No rules fired for today&apos;s sales, orders, refund rate, or average ticket.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
      {data.insights.map((insight) => (
        <InsightCard key={insight.id} insight={insight} />
      ))}
    </div>
  );
}

export function InsightsRowSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: 3 }, (_, index) => (
        <Card key={index}>
          <CardHeader>
            <Skeleton className="h-5 w-3/4" />
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-7 w-20" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
