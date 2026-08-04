"use client";

import { AlertCircle, PlugZap } from "lucide-react";
import type { LoyaltyCohortsResponse, LoyaltySegmentKey } from "@rop/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useGuests } from "@/hooks/use-guests";
import { formatCents, formatCount, formatRate } from "@/lib/format";

const SEGMENT_META: Record<
  LoyaltySegmentKey,
  { label: string; action: string; chart: string }
> = {
  champions: { label: "Champions", action: "Best guests — reward and spotlight them.", chart: "var(--chart-1)" },
  loyal: { label: "Loyal", action: "Buy often — keep them engaged.", chart: "var(--chart-2)" },
  potential_loyalist: {
    label: "Potential Loyalists",
    action: "Recent, building a habit — nurture them.",
    chart: "var(--chart-3)"
  },
  needs_attention: {
    label: "Needs Attention",
    action: "Below-average engagement — give them a reason to return.",
    chart: "var(--chart-4)"
  },
  at_risk: { label: "At Risk", action: "Were valuable, gone quiet — win them back.", chart: "var(--chart-5)" },
  hibernating: {
    label: "Hibernating",
    action: "Long inactive, low value — low-cost reactivation only.",
    chart: "var(--chart-6)"
  }
};

const SEGMENT_ORDER: LoyaltySegmentKey[] = [
  "champions",
  "loyal",
  "potential_loyalist",
  "needs_attention",
  "at_risk",
  "hibernating"
];

export default function GuestsPage() {
  const guests = useGuests();

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-3xl font-medium tracking-tight">Guests</h1>
        <p className="text-muted-foreground">
          Loyalty-member cohorts by RFM (recency, frequency, monetary). Aggregates only — no
          customer details leave the loyalty service.
        </p>
      </header>

      {guests.isError ? (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertTitle>Could not load guest cohorts</AlertTitle>
          <AlertDescription>
            {guests.error instanceof Error ? guests.error.message : "Unknown error."} Try again in a
            moment.
          </AlertDescription>
        </Alert>
      ) : null}

      {guests.isLoading ? (
        <GuestsSkeleton />
      ) : guests.data === null ? (
        <NotConnected />
      ) : guests.data ? (
        <GuestsContent data={guests.data} />
      ) : null}
    </div>
  );
}

function GuestsContent({ data }: { data: LoyaltyCohortsResponse }) {
  const { new_vs_returning: nvr } = data;
  const enrolledNoPurchase = Math.max(0, data.total_members - data.active_members);

  return (
    <>
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard label="Members" value={formatCount(data.total_members)} hint="enrolled in loyalty" />
        <SummaryCard
          label="Active"
          value={formatCount(data.active_members)}
          hint={`${formatCount(enrolledNoPurchase)} enrolled, no purchase`}
        />
        <SummaryCard
          label="New"
          value={formatCount(nvr.new_count)}
          hint={`${formatCents(nvr.new_spend_cents)} lifetime · first purchase`}
        />
        <SummaryCard
          label="Returning"
          value={formatCount(nvr.returning_count)}
          hint={`${formatCents(nvr.returning_spend_cents)} lifetime · 2+ orders`}
        />
      </section>

      {data.active_members > 0 ? <SegmentBar data={data} /> : null}

      {data.active_members === 0 ? (
        <Alert>
          <AlertCircle className="size-4" />
          <AlertTitle>No purchasing members yet</AlertTitle>
          <AlertDescription>
            {formatCount(data.total_members)} guest(s) are enrolled, but none have an earning order
            yet. Cohorts appear once members start buying.
          </AlertDescription>
        </Alert>
      ) : (
        <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {SEGMENT_ORDER.map((key) => {
            const seg = data.segments.find((s) => s.key === key);
            if (!seg) return null;
            const meta = SEGMENT_META[key];
            return (
              <Card key={key} className="flex flex-col gap-3 p-4">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span
                      aria-hidden
                      className="inline-block size-2.5 rounded-full"
                      style={{ background: meta.chart }}
                    />
                    <span className="text-sm font-medium">{meta.label}</span>
                  </div>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {formatRate(seg.pct_of_active, 0)}
                  </span>
                </div>
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-3xl font-semibold tabular-nums tracking-tight">
                    {formatCount(seg.member_count)}
                  </span>
                  <span className="text-xs text-muted-foreground">members</span>
                </div>
                <dl className="flex items-center justify-between text-xs text-muted-foreground">
                  <div>
                    <dt className="inline">Spend </dt>
                    <dd className="inline font-medium tabular-nums text-foreground">
                      {formatCents(seg.total_spend_cents)}
                    </dd>
                  </div>
                  <div>
                    <dt className="inline">Last order </dt>
                    <dd className="inline font-medium tabular-nums text-foreground">
                      {seg.avg_recency_days == null ? "—" : `${Math.round(seg.avg_recency_days)}d avg`}
                    </dd>
                  </div>
                </dl>
                <p className="mt-auto text-[11px] leading-relaxed text-muted-foreground">{meta.action}</p>
              </Card>
            );
          })}
        </section>
      )}

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        RFM is lifetime-based: recency = days since last earning order, frequency = count of earning
        orders, monetary = lifetime eligible spend. Each active member is scored into quintiles on
        each axis and mapped to one segment. As of {new Date(data.as_of).toLocaleString()}.
      </p>
    </>
  );
}

function SegmentBar({ data }: { data: LoyaltyCohortsResponse }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-3 w-full overflow-hidden rounded-full">
        {SEGMENT_ORDER.map((key) => {
          const seg = data.segments.find((s) => s.key === key);
          const pct = seg ? seg.pct_of_active : 0;
          if (pct <= 0) return null;
          return (
            <div
              key={key}
              style={{ width: `${pct * 100}%`, background: SEGMENT_META[key].chart }}
              title={`${SEGMENT_META[key].label}: ${formatRate(pct, 0)}`}
            />
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        {SEGMENT_ORDER.map((key) => (
          <span key={key} className="inline-flex items-center gap-1.5">
            <span aria-hidden className="inline-block size-2 rounded-full" style={{ background: SEGMENT_META[key].chart }} />
            {SEGMENT_META[key].label}
          </span>
        ))}
      </div>
    </div>
  );
}

function SummaryCard({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <Card className="flex flex-col gap-1 p-4">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="font-mono text-3xl font-semibold tabular-nums tracking-tight">{value}</span>
      <span className="text-xs text-muted-foreground">{hint}</span>
    </Card>
  );
}

function NotConnected() {
  return (
    <Alert>
      <PlugZap className="size-4" />
      <AlertTitle>Loyalty service not connected</AlertTitle>
      <AlertDescription>
        Guest cohorts come from the loyalty service (crm-api). Set{" "}
        <code className="font-mono text-xs">INTERNAL_CRM_API_URL</code> and{" "}
        <code className="font-mono text-xs">CRM_INTERNAL_TOKEN</code> for this environment to light
        this up.
      </AlertDescription>
    </Alert>
  );
}

function GuestsSkeleton() {
  return (
    <>
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-[104px] w-full" />
        ))}
      </section>
      <Skeleton className="h-3 w-full" />
      <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-[164px] w-full" />
        ))}
      </section>
    </>
  );
}
