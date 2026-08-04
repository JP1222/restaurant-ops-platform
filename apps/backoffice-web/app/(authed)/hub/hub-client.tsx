"use client";

import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  ArrowUpRight,
  Bot,
  Beaker,
  Briefcase,
  ChevronRight,
  ChefHat,
  CircleCheckBig,
  Clock,
  Cookie,
  Database,
  ExternalLink,
  FilePen,
  FileText,
  Flame,
  GitCompare,
  Globe,
  Inbox,
  LayoutDashboard,
  LayoutGrid,
  Monitor,
  Newspaper,
  Package,
  Pin,
  Plug,
  Rocket,
  RotateCcw,
  Scale,
  ScanLine,
  Settings,
  ShieldCheck,
  Smartphone,
  TrendingUp,
  TriangleAlert,
  Truck,
  Tv,
  Users,
  UtensilsCrossed,
  Wand,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useCrew } from "@/hooks/use-crew";
import { useInventory } from "@/hooks/use-inventory";
import { useOpsOverview } from "@/hooks/use-ops";
import { useToday } from "@/hooks/use-today";
import { recapLabel, type RecapLabel } from "@/lib/analytics-api/today-display";
import type { OpsHealthSummary } from "@/lib/analytics-api/types";
import { formatCents, formatCount, formatPercent, formatRate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { HubClock } from "./hub-clock";

type WsTone = "kds" | "display" | "crew" | "marketing";

type Workstation = {
  id: string;
  title: string;
  subtitle: string;
  description: string;
  icon: LucideIcon;
  href: string;
  tone: WsTone;
  live: { label: string; tone: "live" | "calm" };
  meta: string[];
};

type Shortcut = {
  title: string;
  href: string;
  icon: LucideIcon;
  hint: string;
};

type ToolItem = {
  title: string;
  icon: LucideIcon;
  desc: string;
  href?: string;
  external?: boolean;
  badge?: string;
};

type ToolGroup = {
  label: string;
  desc: string;
  icon: LucideIcon;
  items: ToolItem[];
};

type KpiCell = { label: string; value: string; wowPct: number | null };

// Stable public hostnames, not secrets — the production values are the defaults
// so zero config = production behavior. Each is overridable at build time via a
// NEXT_PUBLIC_* var (e.g. set NEXT_PUBLIC_KDS_ORIGIN=http://localhost:3000 in
// .env.local so the workstation cards open your LOCAL surfaces). Trailing slash
// is trimmed so `${ORIGIN}/board` never becomes `//board`.
const wsOrigin = (override: string | undefined, fallback: string): string =>
  (override?.trim() || fallback).replace(/\/+$/, "");

const KDS_ORIGIN = wsOrigin(process.env.NEXT_PUBLIC_KDS_ORIGIN, "https://kds.example.com");
const CREW_ORIGIN = wsOrigin(process.env.NEXT_PUBLIC_CREW_ORIGIN, "https://crew.example.com");
const MARKETING_ORIGIN = wsOrigin(
  process.env.NEXT_PUBLIC_MARKETING_ORIGIN,
  "https://www.example.com",
);
const LEGAL_ORIGIN = wsOrigin(process.env.NEXT_PUBLIC_LEGAL_ORIGIN, "https://legal.example.com");

const WS_TONE: Record<WsTone, { text: string; softVar: string }> = {
  kds: { text: "text-ws-kds", softVar: "var(--ws-kds-soft)" },
  display: { text: "text-ws-display", softVar: "var(--ws-display-soft)" },
  crew: { text: "text-ws-crew", softVar: "var(--ws-crew-soft)" },
  marketing: { text: "text-ws-marketing", softVar: "var(--ws-marketing-soft)" },
};

// KDS, Customer Display, and Marketing carry static descriptors, not live reads:
// the backoffice has no read path to KDS ticket counts (cross-boundary, Iron Law
// 1/5) or to display/CDN health. They use the calm tone so the chip never implies a
// real-time signal we don't actually have. The Crew card's label IS wired to
// useCrew() at runtime, and the StatusFooter's pipeline chips read ops health.
const WORKSTATIONS: Workstation[] = [
  {
    id: "kds",
    title: "KDS Board",
    subtitle: "Live kitchen tickets",
    description:
      "The board your line is making right now. Open on the kitchen iPad or in a dedicated browser window.",
    icon: Flame,
    href: `${KDS_ORIGIN}/board`,
    tone: "kds",
    live: { label: "Kitchen board", tone: "calm" },
    meta: ["Anytown", "iPad · Pro 12.9"],
  },
  {
    id: "display",
    title: "Customer Display",
    subtitle: "Pickup TV",
    description:
      "Names, order numbers, and ready-state for guests waiting in the lobby. Designed for 1080p TVs.",
    icon: Tv,
    href: `${KDS_ORIGIN}/display`,
    tone: "display",
    live: { label: "Pickup display", tone: "calm" },
    meta: ["ZIP 00000", "Full-screen"],
  },
  {
    id: "crew",
    title: "Crew App",
    subtitle: "Counts · 86's · Receiving",
    description:
      "Mobile-first surface for the line. Update inventory, mark 86'd items, log receiving without leaving the floor.",
    icon: Smartphone,
    href: CREW_ORIGIN,
    tone: "crew",
    live: { label: "Crew app", tone: "calm" },
    meta: ["iOS · Android · Web", "Offline-capable"],
  },
  {
    id: "marketing",
    title: "Marketing Site",
    subtitle: "Public homepage",
    description:
      "Your public-facing site at example.com — menu, gift cards, hours, and the Anytown storefront.",
    icon: Globe,
    href: MARKETING_ORIGIN,
    tone: "marketing",
    live: { label: "example.com", tone: "calm" },
    meta: ["Production"],
  },
];

const PINNED: Shortcut[] = [
  { title: "Today", href: "/today", icon: LayoutDashboard, hint: "Net sales · pacing" },
  { title: "Daily Reset", href: "/settings/reset", icon: RotateCcw, hint: "Close out the day" },
  { title: "86'd Items", href: "/inventory", icon: TriangleAlert, hint: "Mark items unavailable" },
  { title: "Devices", href: "/settings/devices", icon: Monitor, hint: "Paired iPads" },
  { title: "Integrations", href: "/settings/integrations", icon: Plug, hint: "Clover · Deliverect" },
  { title: "AI Assistant", href: "/settings/ai", icon: Bot, hint: "Ask about your data" },
];

const GROUPS: ToolGroup[] = [
  {
    label: "Analytics",
    desc: "Sales and item performance.",
    icon: TrendingUp,
    items: [
      { title: "Today", href: "/today", icon: LayoutDashboard, desc: "Live KPIs, hourly pulse, pacing vs weekday avg." },
      { title: "Trends", href: "/trends", icon: TrendingUp, desc: "Rolling 7 / 28 / 90-day sales and orders." },
      { title: "Compare", href: "/compare", icon: GitCompare, desc: "Period-over-period side-by-side." },
      { title: "Menu", href: "/menu", icon: UtensilsCrossed, desc: "Top items, modifiers, basket attach." },
      { title: "Dayparts", href: "/dayparts", icon: Clock, desc: "Heatmap by weekday × hour." },
    ],
  },
  {
    label: "KDS Admin",
    desc: "Configure the kitchen.",
    icon: Settings,
    items: [
      { title: "Board Settings", href: "/settings/board", icon: Settings, desc: "Station routing, timers, urgency thresholds." },
      { title: "Devices", href: "/settings/devices", icon: Monitor, desc: "Paired iPads and browser displays." },
      { title: "Integrations", href: "/settings/integrations", icon: Plug, desc: "Clover and Deliverect connections." },
      { title: "Daily Reset", href: "/settings/reset", icon: RotateCcw, desc: "Archive today's tickets, reset counters." },
      { title: "Users & Passkeys", href: "/settings/team", icon: Users, desc: "Staff accounts, WebAuthn enrollment." },
    ],
  },
  {
    label: "Inventory",
    desc: "Counts, 86's, receiving.",
    icon: Package,
    items: [
      { title: "Overview", href: "/inventory", icon: LayoutGrid, desc: "On-hand, par status, alerts." },
      { title: "Items", icon: ScanLine, desc: "SKU list with par and cost." },
      { title: "Counts", icon: Beaker, desc: "Open and historical counts." },
      { title: "Receiving", icon: Truck, desc: "Vendor deliveries and invoices." },
      { title: "86'd", icon: TriangleAlert, desc: "Items currently unavailable." },
      { title: "Crew", href: "/inventory/crew", icon: ChefHat, desc: "Staff roster and permissions." },
    ],
  },
  {
    label: "Operations",
    desc: "Pipeline, data health, and deploy.",
    icon: Activity,
    items: [
      { title: "Pipeline", href: "/ops?tab=pipeline", icon: Globe, desc: "Build → image → container." },
      { title: "Sync Health", href: "/ops?tab=sync", icon: Activity, desc: "Clover and Deliverect heartbeats." },
      { title: "Jobs", href: "/ops?tab=jobs", icon: Wand, desc: "Background workers and queues." },
      { title: "Data Quality", href: "/ops?tab=dq", icon: CircleCheckBig, desc: "Schema drift, gaps, duplicates." },
      { title: "Backfill", href: "/ops?tab=backfill", icon: RotateCcw, desc: "Historical window catch-up." },
      { title: "Webhooks", href: "/ops?tab=webhooks", icon: Inbox, desc: "Inbound events and replay." },
      { title: "Database", href: "/ops?tab=database", icon: Database, desc: "Storage, indexes, slow queries." },
      { title: "Deploy", href: "/operations", icon: Rocket, desc: "Ship images; runner health." },
    ],
  },
  {
    label: "Company & Legal",
    desc: "Public site and policies.",
    icon: Scale,
    items: [
      { title: "Press Kit", icon: Newspaper, desc: "Logos, photography, boilerplate." },
      { title: "Terms of Service", icon: FileText, desc: "Customer-facing ToS." },
      { title: "EULA", href: `${LEGAL_ORIGIN}/eula`, external: true, icon: FilePen, desc: "End-user license for KDS and Crew apps." },
      { title: "Privacy Policy", href: `${LEGAL_ORIGIN}/privacy`, external: true, icon: ShieldCheck, desc: "How we collect and process data." },
      { title: "Cookie Policy", icon: Cookie, desc: "Tracking and consent details." },
      { title: "DPA", icon: Briefcase, desc: "Data Processing Addendum for B2B." },
      { title: "Licenses", icon: Scale, desc: "Open-source attributions." },
    ],
  },
];

const TOTAL_PAGES = GROUPS.reduce((sum, group) => sum + group.items.length, 0);
const KPI_LABELS = ["Net sales", "Orders", "Avg ticket", "Refunds"] as const;

function formatSyncAge(seconds: number): string {
  if (seconds < 90) return `synced ${Math.round(seconds)}s ago`;
  if (seconds < 5400) return `synced ${Math.round(seconds / 60)}m ago`;
  return `synced ${Math.round(seconds / 3600)}h ago`;
}

function formatLagAge(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)}s behind`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m behind`;
  return `${Math.round(seconds / 3600)}h behind`;
}

function toCount(value: number | string | null | undefined): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function LiveDot({ tone = "live" }: { tone?: "live" | "calm" }) {
  const color = tone === "calm" ? "bg-foreground/40" : "bg-accent";
  return (
    <span className="relative inline-flex">
      <span className={cn("size-1.5 rounded-full", color)} />
      <span className={cn("pulse-dot absolute inset-0 rounded-full opacity-60", color)} />
    </span>
  );
}

function KpiInline({ label, value, wowPct }: KpiCell) {
  const direction = wowPct === null ? null : wowPct > 0 ? "up" : wowPct < 0 ? "down" : "flat";
  return (
    <div className="flex items-baseline gap-2">
      <div className="text-[12px] text-muted-foreground">{label}</div>
      <div className="text-[15px] font-semibold tracking-tight tabular-nums">{value}</div>
      {direction === "up" || direction === "down" ? (
        <div
          className={cn(
            "text-[11px] font-medium tabular-nums",
            direction === "up" ? "text-trend-up" : "text-trend-down",
          )}
        >
          {direction === "up" ? "▲" : "▼"} {formatPercent(wowPct ?? 0).replace(/[+-]/, "")}
        </div>
      ) : null}
    </div>
  );
}

function KpiCellSkeleton() {
  return (
    <div className="flex items-baseline gap-2">
      <Skeleton className="h-3 w-14" />
      <Skeleton className="h-4 w-12" />
    </div>
  );
}

function HubHeader({
  kpis,
  isLoading,
  recap,
}: {
  kpis: KpiCell[] | null;
  isLoading: boolean;
  recap: RecapLabel | null;
}) {
  return (
    <section className="relative overflow-hidden rounded-2xl bg-card px-6 py-7 ring-1 ring-foreground/10 md:px-8">
      <div className="dot-grid pointer-events-none absolute inset-0 opacity-50" />
      <div className="relative flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2 text-[12px] text-muted-foreground">
            <LiveDot />
            <HubClock />
          </div>
          <h1 className="text-[32px] font-semibold leading-[1.1] tracking-tight md:text-[36px]">
            Hi, JP. <span className="text-muted-foreground">Where to today?</span>
          </h1>
          <p className="mt-2 max-w-xl text-[14.5px] text-muted-foreground">
            Your home base across the Example Kitchen backoffice. Workstations open in a new window so
            this tab stays put.
          </p>
        </div>
        <div className="flex flex-col items-start gap-2 rounded-xl border border-border bg-background/60 px-5 py-4 backdrop-blur">
          {/* Recap: these KPIs are a prior closed day, not today — label them so
              the figures are never misread as live next to the wall clock above. */}
          {recap ? <Badge variant={recap.badgeVariant}>{recap.badge}</Badge> : null}
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-4 md:gap-x-8">
            {isLoading ? (
              KPI_LABELS.map((label) => <KpiCellSkeleton key={label} />)
            ) : kpis ? (
              kpis.map((kpi) => <KpiInline key={kpi.label} {...kpi} />)
            ) : (
              KPI_LABELS.map((label) => (
                <KpiInline key={label} label={label} value="—" wowPct={null} />
              ))
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function SectionTitle({
  eyebrow,
  title,
  hint,
  icon: Icon,
}: {
  eyebrow: string;
  title: string;
  hint?: string;
  icon: LucideIcon;
}) {
  return (
    <div className="mb-3 flex items-end justify-between gap-4 px-1">
      <div className="flex items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
          <Icon className="size-4" strokeWidth={2} />
        </span>
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {eyebrow}
          </div>
          <h2 className="text-[18px] font-semibold leading-tight tracking-tight">{title}</h2>
        </div>
      </div>
      {hint ? (
        <span className="hidden text-[12px] text-muted-foreground md:inline">{hint}</span>
      ) : null}
    </div>
  );
}

function WorkstationCard({ ws }: { ws: Workstation }) {
  const Icon = ws.icon;
  const tone = WS_TONE[ws.tone];
  return (
    <a
      href={ws.href}
      target="_blank"
      rel="noopener noreferrer"
      className="focusring group relative flex flex-col overflow-hidden rounded-2xl bg-card ring-1 ring-foreground/10 transition-all hover:shadow-lift hover:ring-foreground/20"
    >
      <div
        className="relative h-28 overflow-hidden"
        style={{ background: `linear-gradient(135deg, ${tone.softVar} 0%, var(--card) 100%)` }}
      >
        <div className="dot-grid absolute inset-0 opacity-40" />
        <div
          className="absolute -bottom-6 -right-6 size-40 rounded-full opacity-90"
          style={{ background: `radial-gradient(closest-side, ${tone.softVar}, transparent)` }}
        />
        <div className="absolute left-5 right-16 top-4 flex min-w-0 items-center gap-2">
          <span
            className={cn(
              "grid size-10 shrink-0 place-items-center rounded-xl border border-border bg-background/80 backdrop-blur",
              tone.text,
            )}
          >
            <Icon className="size-5" strokeWidth={2} />
          </span>
          <span className="inline-flex min-w-0 items-center gap-1.5 rounded-full border border-border bg-background/80 px-2 py-0.5 text-[11px] font-medium backdrop-blur">
            <LiveDot tone={ws.live.tone} />
            <span className="truncate">{ws.live.label}</span>
          </span>
        </div>
        <div className="absolute right-4 top-4 grid size-8 place-items-center rounded-lg border border-border bg-background/80 text-foreground/70 backdrop-blur transition-colors group-hover:bg-foreground group-hover:text-background">
          <ArrowUpRight className="size-3.5" />
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-3 p-5">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/80">
            {ws.subtitle}
          </div>
          <div className="mt-0.5 text-[19px] font-semibold tracking-tight">{ws.title}</div>
        </div>
        <p className="text-[13.5px] leading-relaxed text-muted-foreground">{ws.description}</p>
        <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-2 text-[11.5px] text-muted-foreground/90">
          {ws.meta.map((entry, index) => (
            <span key={entry} className="flex items-center gap-x-3">
              {index > 0 ? <span className="size-0.5 rounded-full bg-muted-foreground/40" /> : null}
              <span>{entry}</span>
            </span>
          ))}
          <span className="ml-auto inline-flex items-center gap-1 font-medium text-foreground/80 transition-colors group-hover:text-accent">
            Open <ChevronRight className="size-3" />
          </span>
        </div>
      </div>
    </a>
  );
}

function PinnedChip({ item }: { item: Shortcut }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      className="focusring group flex items-center gap-3 rounded-xl bg-card px-3.5 py-3 ring-1 ring-foreground/10 transition-all hover:shadow-xs hover:ring-foreground/20"
    >
      <span className="grid size-9 place-items-center rounded-lg bg-muted text-foreground/80 transition-colors group-hover:bg-accent group-hover:text-accent-foreground">
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13.5px] font-medium">{item.title}</div>
        <div className="truncate text-[11.5px] text-muted-foreground">{item.hint}</div>
      </div>
      <ChevronRight className="size-3.5 text-muted-foreground/60 group-hover:text-foreground" />
    </Link>
  );
}

function GroupItemInner({ item }: { item: ToolItem }) {
  const Icon = item.icon;
  const disabled = !item.href;
  return (
    <>
      <span
        className={cn(
          "grid size-8 shrink-0 place-items-center rounded-md transition-colors",
          disabled
            ? "bg-muted/60 text-muted-foreground/60"
            : "bg-muted text-foreground/75 group-hover:bg-accent-soft group-hover:text-accent",
        )}
      >
        <Icon className="size-[15px]" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={cn("truncate text-[13.5px] font-medium", disabled && "text-muted-foreground")}>
            {item.title}
          </span>
          {item.badge ? (
            <span className="rounded-full border border-trend-down-bg bg-trend-down-bg px-1.5 text-[10px] font-medium text-trend-down tabular-nums">
              {item.badge}
            </span>
          ) : null}
          {disabled ? (
            <span className="rounded-full border border-border px-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
              Soon
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 truncate text-[12px] leading-snug text-muted-foreground">
          {item.desc}
        </div>
      </div>
      {disabled ? null : item.external ? (
        <ExternalLink className="mt-1.5 size-3 shrink-0 text-muted-foreground/50 group-hover:text-foreground/70" />
      ) : (
        <ChevronRight className="mt-1.5 size-3 shrink-0 text-muted-foreground/50 group-hover:text-foreground/70" />
      )}
    </>
  );
}

function GroupItem({ item }: { item: ToolItem }) {
  const base =
    "group flex items-start gap-3 rounded-lg border border-transparent px-3 py-2.5 transition-colors";

  if (!item.href) {
    return (
      <div className={cn(base, "cursor-default opacity-70")} aria-disabled="true">
        <GroupItemInner item={item} />
      </div>
    );
  }

  if (item.external) {
    return (
      <a
        href={item.href}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(base, "focusring hover:border-border hover:bg-muted/40")}
      >
        <GroupItemInner item={item} />
      </a>
    );
  }

  return (
    <Link href={item.href} className={cn(base, "focusring hover:border-border hover:bg-muted/40")}>
      <GroupItemInner item={item} />
    </Link>
  );
}

function GroupCard({ group }: { group: ToolGroup }) {
  const Icon = group.icon;
  return (
    <Card className="gap-0 rounded-2xl py-0">
      <div className="flex items-start gap-3 border-b border-border px-5 py-4">
        <span className="grid size-9 place-items-center rounded-lg bg-accent-soft text-accent">
          <Icon className="size-4" strokeWidth={2} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold tracking-tight">{group.label}</div>
          <div className="text-[12.5px] text-muted-foreground">{group.desc}</div>
        </div>
        <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
          {group.items.length}
        </span>
      </div>
      <div className="space-y-0.5 p-2">
        {group.items.map((item) => (
          <GroupItem key={item.title} item={item} />
        ))}
      </div>
    </Card>
  );
}

function StatusFooter({
  cloverLabel,
  health,
}: {
  cloverLabel: string;
  health: OpsHealthSummary | null;
}) {
  // Wired to the ops health summary the page already fetches — no fabricated figures.
  const issueCount =
    health === null
      ? null
      : toCount(health.failed_job_count) +
        toCount(health.dq_failed_count) +
        toCount(health.open_repair_count);
  const systemLabel =
    issueCount === null
      ? "Status in System Health"
      : issueCount === 0
        ? "All systems nominal"
        : `${issueCount.toLocaleString()} need attention`;
  const webhookLag = health?.webhook_lag_seconds == null ? null : toCount(health.webhook_lag_seconds);
  const backlog = health === null ? null : toCount(health.dirty_window_backlog);

  return (
    <footer className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-2xl bg-muted/30 px-5 py-4 text-[12px] text-muted-foreground ring-1 ring-foreground/10">
      <div className="flex items-center gap-2">
        <LiveDot tone={issueCount === 0 ? "live" : "calm"} /> <span>{systemLabel}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <Plug className="size-3.5" /> Clover · {cloverLabel}
      </div>
      <div className="flex items-center gap-1.5">
        <Inbox className="size-3.5" /> Webhooks ·{" "}
        {webhookLag === null ? "no recent events" : formatLagAge(webhookLag)}
      </div>
      <div className="flex items-center gap-1.5">
        <Database className="size-3.5" /> Mart ·{" "}
        {backlog === null ? "—" : backlog === 0 ? "current" : `${backlog.toLocaleString()} dirty`}
      </div>
      <Link href="/ops" className="ml-auto flex items-center gap-1.5 hover:text-accent">
        <Activity className="size-3.5" /> Open System Health
      </Link>
    </footer>
  );
}

export function HubClient() {
  const today = useToday();
  const inventory = useInventory();
  const crew = useCrew();
  const ops = useOpsOverview();

  const kpis: KpiCell[] | null = today.data
    ? [
        {
          label: "Net sales",
          value: formatCents(today.data.kpis.net_sales.value),
          wowPct: today.data.kpis.net_sales.wow_pct,
        },
        {
          label: "Orders",
          value: formatCount(today.data.kpis.orders.value),
          wowPct: today.data.kpis.orders.wow_pct,
        },
        {
          label: "Avg ticket",
          value: formatCents(today.data.kpis.avg_ticket.value),
          wowPct: today.data.kpis.avg_ticket.wow_pct,
        },
        {
          label: "Refunds",
          value: formatRate(today.data.kpis.refund_rate.value),
          wowPct: today.data.kpis.refund_rate.wow_pct,
        },
      ]
    : null;

  const recap = today.data?.mode === "recap" ? recapLabel(today.data) : null;

  const eightySix = inventory.data?.items.filter((item) => item.flagged_86).length ?? null;
  const eightySixHint =
    eightySix === null
      ? "Mark items unavailable"
      : eightySix === 0
        ? "Nothing 86'd"
        : `${eightySix} item${eightySix === 1 ? "" : "s"} 86'd`;
  const eightySixBadge = eightySix && eightySix > 0 ? String(eightySix) : undefined;

  const crewCount = crew.data?.employees.filter((employee) => employee.active).length ?? null;

  const cloverHeartbeat = ops.data?.heartbeats.find((hb) => hb.component === "clover");
  const cloverAgeSeconds =
    cloverHeartbeat?.age_seconds != null ? Number(cloverHeartbeat.age_seconds) : null;
  const cloverLabel =
    cloverAgeSeconds === null || Number.isNaN(cloverAgeSeconds)
      ? "status in System Health"
      : formatSyncAge(cloverAgeSeconds);

  const workstations = WORKSTATIONS.map((ws) =>
    ws.id === "crew"
      ? {
          ...ws,
          live: {
            label: crewCount === null ? "Crew app" : `${crewCount} staff`,
            tone: "calm" as const,
          },
        }
      : ws,
  );

  const pinned = PINNED.map((item) =>
    item.title === "86'd Items" ? { ...item, hint: eightySixHint } : item,
  );

  const groups = GROUPS.map((group) =>
    group.label === "Inventory"
      ? {
          ...group,
          items: group.items.map((item) =>
            item.title === "86'd" ? { ...item, badge: eightySixBadge } : item,
          ),
        }
      : group,
  );

  return (
    <div className="mx-auto flex max-w-[1320px] flex-col gap-6">
      <HubHeader kpis={kpis} isLoading={today.isLoading} recap={recap} />

      <section>
        <SectionTitle
          eyebrow="Workstations"
          title="Open a live surface"
          hint="External · opens in a new window"
          icon={Monitor}
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {workstations.map((ws) => (
            <WorkstationCard key={ws.id} ws={ws} />
          ))}
        </div>
      </section>

      <section>
        <SectionTitle
          eyebrow="Pinned"
          title="Your shortcuts"
          hint="Quick access to everyday pages"
          icon={Pin}
        />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          {pinned.map((item) => (
            <PinnedChip key={item.title} item={item} />
          ))}
        </div>
      </section>

      <section>
        <SectionTitle
          eyebrow="Everything else"
          title="Browse all tools"
          hint={`${TOTAL_PAGES} pages across ${GROUPS.length} areas`}
          icon={LayoutGrid}
        />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {groups.map((group) => (
            <GroupCard key={group.label} group={group} />
          ))}
        </div>
      </section>

      <StatusFooter cloverLabel={cloverLabel} health={ops.data?.health ?? null} />
    </div>
  );
}
