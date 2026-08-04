"use client";

import { CircleDollarSign, RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAiUsage } from "@/hooks/use-ai-usage";
import { useRefreshAiPrices } from "@/hooks/use-refresh-ai-prices";
import type { AiUsagePeriod } from "@/lib/ai/usage";
import { formatCount, formatUnitCost } from "@/lib/format";
import { Segmented } from "../segmented";
import { SettingsCard } from "./settings-card";

const PERIODS = [
  { value: "7d", label: "7 days" },
  { value: "month", label: "This month" },
  { value: "last", label: "Last month" },
];

// Friendly labels for the recorded `feature` values (lib/ai/db.ts AiUsageFeature).
const FEATURE_LABEL: Record<string, string> = {
  chat: "Chat",
  vision_scan: "Invoice scan",
  matcher: "Receipt match",
  emoji: "Emoji",
};

// USD (sub-cent capable) from a dollar amount; formatUnitCost takes cents.
const usd = (dollars: number) => formatUnitCost(dollars * 100);

// Compact token counts for the dense per-row cells (128,000 -> 128K) so the
// 5-column table fits the card without clipping the cost column. Tiles + totals
// keep full precision via formatCount.
const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const compact = (n: number) => COMPACT.format(n);

export function AiUsageCard() {
  const [period, setPeriod] = useState<AiUsagePeriod>("7d");
  const { data, isLoading, isError } = useAiUsage(period);

  return (
    <SettingsCard
      icon={CircleDollarSign}
      title="Usage & cost"
      description="Estimated spend per model from logged tokens. A guide, not your bill."
    >
      <div className="space-y-4 pt-1 pb-4">
        <Segmented
          aria-label="Usage period"
          value={period}
          onValueChange={(v) => setPeriod(v as AiUsagePeriod)}
          options={PERIODS}
        />

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading usage…</p>
        ) : isError ? (
          <p className="text-sm text-destructive">Couldn&apos;t load usage.</p>
        ) : !data || data.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No AI usage recorded for this period yet.</p>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-3">
              <Tile
                label="Estimated spend"
                value={`${data.totals.hasUnpriced ? "≥ " : ""}${usd(data.totals.estCostUsd)}`}
              />
              <Tile label="Requests" value={formatCount(data.totals.requests)} />
              <Tile
                label="Tokens"
                value={formatCount(data.totals.inputTokens + data.totals.outputTokens)}
              />
            </div>

            <div className="overflow-x-auto rounded-lg border">
              <Table className="text-xs [&_:is(th,td)]:px-2.5 [&_:is(th,td)]:py-2">
                <TableHeader>
                  <TableRow>
                    <TableHead>Model</TableHead>
                    <TableHead>Feature</TableHead>
                    <TableHead className="text-right">Reqs</TableHead>
                    <TableHead className="text-right whitespace-nowrap">Tokens in/out</TableHead>
                    <TableHead className="text-right">Est. cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.rows.map((row) => (
                    <TableRow key={`${row.modelId}:${row.feature}`}>
                      <TableCell className="font-mono">{row.modelId}</TableCell>
                      <TableCell className="whitespace-nowrap">
                        {FEATURE_LABEL[row.feature] ?? row.feature}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCount(row.requests)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums whitespace-nowrap text-muted-foreground">
                        {compact(row.inputTokens)} / {compact(row.outputTokens)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums whitespace-nowrap">
                        {row.estCostUsd === null ? (
                          <span className="text-muted-foreground" title="No list price on file for this model">
                            —
                          </span>
                        ) : (
                          usd(row.estCostUsd)
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                <TableFooter>
                  <TableRow>
                    <TableCell colSpan={2} className="font-medium">
                      Total
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-medium">
                      {formatCount(data.totals.requests)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums whitespace-nowrap font-medium text-muted-foreground">
                      {compact(data.totals.inputTokens)} / {compact(data.totals.outputTokens)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums whitespace-nowrap font-medium">
                      {data.totals.hasUnpriced ? "≥ " : ""}
                      {usd(data.totals.estCostUsd)}
                    </TableCell>
                  </TableRow>
                </TableFooter>
              </Table>
            </div>

            <p className="text-xs text-muted-foreground">
              Estimated from logged tokens at published list prices — a guide, not your bill.
              {data.totals.hasUnpriced
                ? " Some models have no price on file (shown as —), so the total is a floor."
                : null}
            </p>
          </>
        )}

        <PriceRefreshRow updatedAt={data?.pricesUpdatedAt ?? null} />
      </div>
    </SettingsCard>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-muted/30 px-3 py-2.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

// Coarse "x minutes/hours/days ago" for the price-refresh timestamp. Browser-only
// (Date.now), which is fine in this client component.
function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const minutes = Math.round(diffMs / 60_000);
  if (Math.abs(minutes) < 60) return rtf.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return rtf.format(-hours, "hour");
  return rtf.format(-Math.round(hours / 24), "day");
}

// Persistent footer: when prices were last synced + a manual refresh. Pulls the latest
// LiteLLM prices into the cache so a newly-selected model gets priced; the weekly cron
// (follow-up) hits the same path. Shown even with no usage yet so prices can be primed.
function PriceRefreshRow({ updatedAt }: { updatedAt: string | null }) {
  const refresh = useRefreshAiPrices();
  return (
    <div className="flex items-center justify-between gap-3 border-t pt-3">
      <p className="text-xs text-muted-foreground">
        {updatedAt
          ? `Prices updated ${formatRelativeTime(updatedAt)}`
          : "Using built-in prices — refresh to pull the latest."}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={refresh.isPending}
        onClick={() =>
          refresh.mutate(undefined, {
            onSuccess: (result) =>
              toast.success(`Updated ${formatCount(result.modelCount)} model prices`),
            onError: () => toast.error("Couldn't refresh prices. Try again."),
          })
        }
      >
        <RefreshCw className={refresh.isPending ? "size-3.5 animate-spin" : "size-3.5"} />
        {refresh.isPending ? "Refreshing…" : "Refresh prices"}
      </Button>
    </div>
  );
}
