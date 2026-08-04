"use client";

import { Info, Plug } from "lucide-react";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table";
import { formatCents, formatRate } from "@/lib/format";
import {
  DEFERRED_METRICS,
  METRIC_SOURCE,
  REAL_PROVENANCE_ORDER,
  type MetricSource
} from "@/lib/costs/bands";
import type { CostsResponse } from "@/lib/analytics-api/types";

function SourceTag({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-border/80 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </span>
  );
}

function formatMetricValue(unit: string, value: number | null): string {
  if (value == null) return "—";
  if (unit === "ratio") return formatRate(value);
  if (unit === "cents") return formatCents(value);
  return String(value);
}

interface ProvenanceRow {
  id: string;
  label: string;
  definition: string;
  source: MetricSource;
  resolved: string;
  status: "ok" | "not_connected" | "partial";
}

export interface ProvenanceTableProps {
  metrics: CostsResponse["metrics"];
}

/**
 * Every figure on the page ties back to a registered metric (ADR-0030). The
 * real rows come straight from the registry-resolved response (definition +
 * value); the deferred rows show an honest not-connected/partial status.
 */
export function ProvenanceTable({ metrics }: ProvenanceTableProps) {
  const realRows: ProvenanceRow[] = REAL_PROVENANCE_ORDER.flatMap((id) => {
    const metric = metrics[id];
    if (!metric) return [];
    return [
      {
        id,
        label: metric.label,
        definition: metric.definition,
        source: METRIC_SOURCE[id] ?? "Analytics",
        resolved: formatMetricValue(metric.unit, metric.value),
        status: "ok" as const
      }
    ];
  });

  const deferredRows: ProvenanceRow[] = DEFERRED_METRICS.map((m) => {
    // A deferred metric (labor / prime) promotes to a real row the moment the
    // registry resolves a value for it — i.e. once labor has been configured.
    const live = metrics[m.id];
    if (live && live.value != null) {
      return {
        id: m.id,
        label: live.label || m.label,
        definition: live.definition || m.definition,
        source: m.source,
        resolved: formatMetricValue(live.unit, live.value),
        status: "ok" as const
      };
    }
    return {
      id: m.id,
      label: m.label,
      definition: m.definition,
      source: m.source,
      resolved: m.status === "not_connected" ? "not connected" : "partial",
      status: m.status
    };
  });

  const rows = [...realRows, ...deferredRows];

  return (
    <Card className="border-dashed bg-muted/20">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Info className="size-[15px] text-muted-foreground" />
          <CardTitle className="text-base font-medium">How these figures are measured</CardTitle>
        </div>
        <CardDescription>
          Every number on this page resolves through a registered metric (
          <span className="font-mono">resolveMetric</span>, ADR-0030). Definitions live in the
          metric layer — never in the view.
        </CardDescription>
      </CardHeader>
      <div className="px-2 pb-3 sm:px-3">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-xs">Metric</TableHead>
              <TableHead className="text-xs">Definition</TableHead>
              <TableHead className="text-xs">Source</TableHead>
              <TableHead className="text-right text-xs">Resolves to</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id} className="align-top">
                <TableCell>
                  <span className="font-mono text-xs">{row.id}</span>
                  <div className="text-[11px] text-muted-foreground">{row.label}</div>
                </TableCell>
                <TableCell className="font-mono text-[11.5px] text-muted-foreground">
                  {row.definition}
                </TableCell>
                <TableCell>
                  <SourceTag>{row.source}</SourceTag>
                </TableCell>
                <TableCell className="text-right">
                  {row.status === "ok" ? (
                    <span className="font-mono tabular-nums font-medium">{row.resolved}</span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
                      <Plug className="size-3" />
                      {row.resolved}
                    </span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Card>
  );
}
