"use client";

import { useEffect } from "react";
import { DateTime } from "luxon";
import { AlertCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { KpiCard, KpiCardSkeleton } from "@/components/kpi/kpi-card";
import { HourlyPulseChart, HourlyPulseChartSkeleton } from "@/components/today/hourly-pulse-chart";
import { InsightsRow, InsightsRowSkeleton } from "@/components/today/insights-row";
import { PacingIndicator } from "@/components/today/pacing-indicator";
import { TopItemsCard, TopItemsCardSkeleton } from "@/components/today/top-items-card";
import { WowBars, WowBarsSkeleton } from "@/components/today/wow-bars";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useTodayHourly } from "@/hooks/use-today-hourly";
import { useTodayInsights } from "@/hooks/use-today-insights";
import { useTodayTopItems } from "@/hooks/use-today-top-items";
import { useTodayWow } from "@/hooks/use-today-wow";
import { useToday } from "@/hooks/use-today";
import { formatBusinessDate, recapLabel, recapSubtitle } from "@/lib/analytics-api/today-display";
import { formatCents, formatCount, formatRate } from "@/lib/format";
import { useAiAssistantStore } from "@/stores/ai-assistant";

const WEEKDAY_LABEL = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function TodayPage() {
  const setViewSnapshot = useAiAssistantStore((s) => s.setViewSnapshot);
  const today = useToday();
  const hourly = useTodayHourly();
  const insights = useTodayInsights();
  const topItems = useTodayTopItems();
  const wow = useTodayWow();

  useEffect(() => {
    if (!today.data) return;
    setViewSnapshot({
      view: "today",
      url: `${window.location.pathname}${window.location.search}`,
      data: today.data,
      capturedAt: new Date().toISOString(),
    });
  }, [today.data, setViewSnapshot]);
  const weekdayLabel = today.data ? WEEKDAY_LABEL[today.data.weekday] : "weekday";
  const displayError = today.isError
    ? today.error
    : hourly.isError
      ? hourly.error
      : insights.isError
        ? insights.error
        : topItems.isError
          ? topItems.error
          : wow.isError
            ? wow.error
            : null;

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-1">
        <div className="flex items-center gap-3">
          <h1 className="text-3xl font-medium tracking-tight">Today</h1>
          {today.data?.mode === "recap" ? (
            <Badge variant={recapLabel(today.data).badgeVariant}>
              {recapLabel(today.data).badge}
            </Badge>
          ) : null}
        </div>
        <p className="text-muted-foreground">
          {today.data
            ? today.data.mode === "live"
              ? `Today · ${formatBusinessDate(today.data.business_date, today.data.store_timezone)}`
              : recapSubtitle(today.data, DateTime.now())
            : "Live KPIs and hourly pulse."}
        </p>
      </header>

      {displayError ? (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertTitle>Could not load today&apos;s data</AlertTitle>
          <AlertDescription>
            {displayError instanceof Error ? displayError.message : "Unknown error."} Try again in a
            moment.
          </AlertDescription>
        </Alert>
      ) : null}

      <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {today.isLoading ? (
          <>
            <KpiCardSkeleton />
            <KpiCardSkeleton />
            <KpiCardSkeleton />
            <KpiCardSkeleton />
          </>
        ) : today.data ? (
          <>
            <KpiCard
              label="Net Sales"
              value={formatCents(today.data.kpis.net_sales.value)}
              comparisonLabel={`vs ${weekdayLabel} avg`}
              wowPct={today.data.kpis.net_sales.wow_pct}
              hint={today.data.is_current_day ? "running total" : undefined}
            />
            <KpiCard
              label="Orders"
              value={formatCount(today.data.kpis.orders.value)}
              comparisonLabel={`vs ${weekdayLabel} avg`}
              wowPct={today.data.kpis.orders.wow_pct}
              hint={today.data.is_current_day ? "running total" : undefined}
            />
            <KpiCard
              label="Avg Ticket"
              value={formatCents(today.data.kpis.avg_ticket.value)}
              comparisonLabel={`vs ${weekdayLabel} avg`}
              wowPct={today.data.kpis.avg_ticket.wow_pct}
            />
            <KpiCard
              label="Refunds"
              value={formatCents(today.data.kpis.refunds.value)}
              comparisonLabel={`vs ${weekdayLabel} rate avg`}
              wowPct={today.data.kpis.refund_rate.wow_pct}
              hint={`${formatRate(today.data.kpis.refund_rate.value)} of net sales`}
            />
          </>
        ) : null}
      </section>

      <section>
        {/* Insights narrate live, intraday performance — suppress them in recap
            mode so a closed day's numbers are never framed as "today". */}
        {today.data?.mode !== "live" || insights.isError ? null : insights.isLoading ? (
          <InsightsRowSkeleton />
        ) : insights.data ? (
          <InsightsRow data={insights.data} />
        ) : null}
      </section>

      {hourly.isError ? null : hourly.isLoading ? (
        <HourlyPulseChartSkeleton />
      ) : hourly.data ? (
        <div className="flex flex-col gap-4">
          <HourlyPulseChart data={hourly.data} />
          {hourly.data.pacing ? <PacingIndicator pacing={hourly.data.pacing} /> : null}
        </div>
      ) : null}

      <section className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {topItems.isError ? null : topItems.isLoading ? (
          <TopItemsCardSkeleton />
        ) : topItems.data ? (
          <TopItemsCard data={topItems.data} />
        ) : null}

        {wow.isError ? null : wow.isLoading ? (
          <WowBarsSkeleton />
        ) : wow.data ? (
          <WowBars data={wow.data} />
        ) : null}
      </section>
    </div>
  );
}
