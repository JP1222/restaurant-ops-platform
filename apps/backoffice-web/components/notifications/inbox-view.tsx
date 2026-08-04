"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Archive, CheckCheck, Clock, Search, SearchX, Settings2, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  filterNotifications,
  groupByTime,
  readCount,
  severityCounts,
  type SeverityFilter,
} from "@/lib/notifications/derive";
import { categoryMeta, severityMeta } from "@/lib/notifications/meta";
import type { Notification } from "@/lib/notifications/types";
import { useNotificationStore } from "@/stores/notifications";
import { cn } from "@/lib/utils";
import { AiInvestigation } from "./ai-investigation";
import { NotifIcon } from "./notif-icon";

const CHIPS: { key: SeverityFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "crit", label: "Critical" },
  { key: "warn", label: "Warning" },
  { key: "info", label: "Info" },
];

const SUMMARY: { key: "crit" | "warn" | "info"; label: string; dot: string }[] = [
  { key: "crit", label: "Critical", dot: "bg-destructive" },
  { key: "warn", label: "Warning", dot: "bg-warn" },
  { key: "info", label: "Info", dot: "bg-muted-foreground" },
];

export function InboxView() {
  const items = useNotificationStore((s) => s.items);
  const filter = useNotificationStore((s) => s.filter);
  const query = useNotificationStore((s) => s.query);
  const setFilter = useNotificationStore((s) => s.setFilter);
  const setQuery = useNotificationStore((s) => s.setQuery);
  const markAllRead = useNotificationStore((s) => s.markAllRead);
  const archiveRead = useNotificationStore((s) => s.archiveRead);

  const counts = severityCounts(items);
  const filtered = filterNotifications(items, filter, query);
  const groups = groupByTime(filtered);
  const hasRead = readCount(items) > 0;
  const isFiltered = query.trim().length > 0 || filter !== "all";

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Inbox</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Everything the backoffice flagged while you were away — clear it in one pass.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {hasRead ? (
            <Button variant="outline" size="sm" className="h-[34px] gap-1.5" onClick={() => archiveRead()}>
              <Archive className="size-3.5" /> Archive read
            </Button>
          ) : null}
          <Button variant="outline" size="sm" className="h-[34px] gap-1.5" onClick={() => markAllRead()}>
            <CheckCheck className="size-3.5" /> Mark all read
          </Button>
          <Button asChild variant="outline" size="icon" className="size-[34px]" aria-label="Notification preferences">
            <Link href="/settings/notifications">
              <Settings2 className="size-4" />
            </Link>
          </Button>
        </div>
      </div>

      <div className="mt-5 flex gap-2.5">
        {SUMMARY.map((s) => (
          <div
            key={s.key}
            className="flex flex-1 items-center gap-2.5 rounded-[10px] border border-border bg-card px-3.5 py-3"
          >
            <span className={cn("size-2.5 rounded-full", s.dot)} />
            <span className="text-[22px] font-semibold tracking-tight tabular-nums">{counts[s.key]}</span>
            <span className="text-[12.5px] text-muted-foreground">{s.label}</span>
          </div>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {CHIPS.map((c) => {
          const active = filter === c.key;
          return (
            <button
              key={c.key}
              type="button"
              onClick={() => setFilter(c.key)}
              className={cn(
                "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium transition-colors",
                active
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-card text-muted-foreground hover:bg-muted",
              )}
            >
              {c.label}
              <span
                className={cn(
                  "font-mono text-[11px] tabular-nums",
                  active ? "text-primary-foreground" : "text-muted-foreground",
                )}
              >
                {counts[c.key]}
              </span>
            </button>
          );
        })}
      </div>

      <div className="relative mt-3">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search notifications"
          aria-label="Search notifications"
          className="h-[38px] rounded-[9px] pl-9"
        />
      </div>

      {groups.map((g) => (
        <div key={g.label}>
          <div className="mt-6 mb-2.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
            {g.label}
          </div>
          <div className="flex flex-col gap-2">
            {g.items.map((n) => (
              <InboxRow key={n.id} n={n} />
            ))}
          </div>
        </div>
      ))}

      {groups.length === 0 ? (
        <div className="px-0 pt-[90px] pb-10 text-center text-muted-foreground">
          <div className="mx-auto inline-flex size-12 items-center justify-center rounded-full bg-accent-soft text-accent">
            {isFiltered ? <SearchX className="size-[22px]" /> : <CheckCheck className="size-[22px]" />}
          </div>
          <div className="mt-3.5 text-[15px] font-semibold text-foreground">
            {isFiltered ? "No matching notifications" : "You're all caught up"}
          </div>
          <div className="mt-1 text-[13px]">
            {isFiltered ? "Try a different filter or search." : "New events will show up here."}
          </div>
        </div>
      ) : null}

      <div className="h-10" />
    </div>
  );
}

function InboxRow({ n }: { n: Notification }) {
  const expanded = useNotificationStore((s) => s.expandedAiIds.includes(n.id));
  const markRead = useNotificationStore((s) => s.markRead);
  const dismiss = useNotificationStore((s) => s.dismiss);
  const snooze = useNotificationStore((s) => s.snooze);
  const toggleAi = useNotificationStore((s) => s.toggleAi);
  const router = useRouter();

  const sev = severityMeta[n.severity];
  const cat = categoryMeta[n.category];

  return (
    <div
      onClick={() => markRead(n.id)}
      className="relative flex cursor-pointer gap-3 rounded-xl border border-border bg-card py-[15px] pr-4 pl-[18px] transition-colors hover:border-foreground/25"
    >
      <span className={cn("absolute inset-y-3 left-0 w-[3px] rounded-r-[3px]", sev.bar)} />
      {!n.read ? <span className="absolute top-[19px] left-[9px] size-1.5 rounded-full bg-accent" /> : null}
      <div
        className={cn(
          "ml-1 inline-flex size-9 shrink-0 items-center justify-center rounded-[9px]",
          sev.tileBg,
          sev.text,
        )}
      >
        <NotifIcon name={n.icon} className="size-[17px]" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={cn("text-sm tracking-tight", n.read ? "font-medium" : "font-semibold")}>
            {n.title}
          </span>
          <span
            className={cn(
              "rounded-[5px] px-1.5 py-px text-[10.5px] font-medium whitespace-nowrap",
              cat.tagBg,
              cat.tagText,
            )}
          >
            {n.categoryLabel}
          </span>
          <span className="flex-1" />
          <span className="shrink-0 font-mono text-[11.5px] text-muted-foreground tabular-nums">
            {n.timeLabel}
          </span>
          <button
            type="button"
            aria-label="Snooze 1 hour"
            onClick={(e) => {
              e.stopPropagation();
              snooze(n.id);
            }}
            className="inline-flex size-[22px] shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Clock className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={(e) => {
              e.stopPropagation();
              dismiss(n.id);
            }}
            className="-mr-1 inline-flex size-[22px] shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>
        <p className="mt-1 text-[13px] leading-normal text-pretty text-muted-foreground">{n.detail}</p>
        <div className="mt-[11px] flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              markRead(n.id);
              router.push(n.action.href);
            }}
            className="inline-flex h-[30px] items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-[12.5px] font-semibold whitespace-nowrap transition-colors hover:bg-muted"
          >
            <NotifIcon name={n.action.icon} className="size-3.5" /> {n.action.label}
          </button>
          <span className="flex-1" />
          {n.ai ? (
            <button
              type="button"
              aria-label="Ask AI"
              aria-pressed={expanded}
              onClick={(e) => {
                e.stopPropagation();
                toggleAi(n.id);
              }}
              className={cn(
                "inline-flex size-[30px] items-center justify-center rounded-lg text-accent transition-colors hover:bg-accent-soft",
                expanded && "bg-accent-soft",
              )}
            >
              <Sparkles className="size-4" />
            </button>
          ) : null}
        </div>
        {expanded && n.ai ? (
          <AiInvestigation id={n.id} severity={n.severity} investigation={n.ai} />
        ) : null}
      </div>
    </div>
  );
}
