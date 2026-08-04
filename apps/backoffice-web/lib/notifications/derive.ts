import { differenceInCalendarDays, differenceInMinutes, format } from "date-fns";
import type { Notification, NotificationGroup, Severity } from "./types";

const SEV_RANK: Record<Severity, number> = { crit: 0, warn: 1, info: 2 };

/** Time-group bucket derived from a created timestamp relative to a reference. */
export function deriveGroup(createdAt: string, now: Date): NotificationGroup {
  const days = differenceInCalendarDays(now, new Date(createdAt));
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return "Earlier this week";
}

/** Compact relative label ("8m", "1h", "Yesterday", "Mon"). */
export function deriveTimeLabel(createdAt: string, now: Date): string {
  const created = new Date(createdAt);
  const mins = differenceInMinutes(now, created);
  if (mins < 60) return `${Math.max(1, Math.round(mins))}m`;
  const days = differenceInCalendarDays(now, created);
  if (days <= 0) return `${Math.round(mins / 60)}h`;
  if (days === 1) return "Yesterday";
  return format(created, "EEE");
}

export function compareSeverity(a: Notification, b: Notification): number {
  return SEV_RANK[a.severity] - SEV_RANK[b.severity];
}

/** Visible everywhere: not dismissed, and not under an active snooze. */
export function isLive(n: Notification, now: number = Date.now()): boolean {
  if (n.dismissedAt) return false;
  if (n.snoozedUntil && new Date(n.snoozedUntil).getTime() > now) return false;
  return true;
}

export function liveNotifications(items: Notification[]): Notification[] {
  return items.filter((n) => isLive(n));
}

export function unreadCount(items: Notification[]): number {
  return liveNotifications(items).filter((n) => !n.read).length;
}

export function readCount(items: Notification[]): number {
  return liveNotifications(items).filter((n) => n.read).length;
}

export type SeverityCounts = Record<"all" | Severity, number>;

export function severityCounts(items: Notification[]): SeverityCounts {
  const live = liveNotifications(items);
  return {
    all: live.length,
    crit: live.filter((n) => n.severity === "crit").length,
    warn: live.filter((n) => n.severity === "warn").length,
    info: live.filter((n) => n.severity === "info").length,
  };
}

export type SeverityFilter = "all" | Severity;

export function filterNotifications(
  items: Notification[],
  filter: SeverityFilter,
  query: string,
): Notification[] {
  const live = liveNotifications(items);
  const bySev = filter === "all" ? live : live.filter((n) => n.severity === filter);
  const q = query.trim().toLowerCase();
  if (!q) return bySev;
  return bySev.filter((n) =>
    `${n.title} ${n.detail} ${n.categoryLabel}`.toLowerCase().includes(q),
  );
}

const GROUP_ORDER: NotificationGroup[] = ["Today", "Yesterday", "Earlier this week"];

export function groupByTime(
  items: Notification[],
): { label: NotificationGroup; items: Notification[] }[] {
  return GROUP_ORDER.map((label) => ({
    label,
    items: items.filter((n) => n.group === label),
  })).filter((g) => g.items.length > 0);
}
