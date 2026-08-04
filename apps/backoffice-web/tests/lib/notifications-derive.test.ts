import { describe, expect, test } from "vitest";
import {
  compareSeverity,
  deriveGroup,
  deriveTimeLabel,
  filterNotifications,
  groupByTime,
  isLive,
  liveNotifications,
  readCount,
  severityCounts,
  unreadCount,
} from "@/lib/notifications/derive";
import type { Notification, Severity } from "@/lib/notifications/types";

function make(id: string, over: Partial<Notification> = {}): Notification {
  return {
    id,
    severity: "info",
    category: "sales",
    categoryLabel: "Sales",
    icon: "trending-up",
    title: `Title ${id}`,
    detail: `Detail ${id}`,
    createdAt: "2025-05-22T17:00:00.000Z",
    group: "Today",
    timeLabel: "1h",
    read: false,
    action: { label: "Open", icon: "external-link", href: "/today" },
    ...over,
  };
}

// Afternoon UTC keeps calendar-day diffs stable across runner timezones.
const NOW = new Date("2025-05-22T17:00:00.000Z");

describe("notifications/derive · time derivation", () => {
  test("deriveTimeLabel renders minutes, hours, yesterday, weekday", () => {
    expect(deriveTimeLabel(new Date(NOW.getTime() - 8 * 60000).toISOString(), NOW)).toBe("8m");
    expect(deriveTimeLabel(new Date(NOW.getTime() - 65 * 60000).toISOString(), NOW)).toBe("1h");
    expect(deriveTimeLabel("2025-05-21T17:00:00.000Z", NOW)).toBe("Yesterday");
    expect(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/.test(deriveTimeLabel("2025-05-19T17:00:00.000Z", NOW))).toBe(true);
  });

  test("deriveGroup buckets Today / Yesterday / Earlier this week", () => {
    expect(deriveGroup(NOW.toISOString(), NOW)).toBe("Today");
    expect(deriveGroup("2025-05-21T17:00:00.000Z", NOW)).toBe("Yesterday");
    expect(deriveGroup("2025-05-19T17:00:00.000Z", NOW)).toBe("Earlier this week");
  });
});

describe("notifications/derive · live + counts", () => {
  test("isLive hides dismissed and actively-snoozed items", () => {
    expect(isLive(make("a"))).toBe(true);
    expect(isLive(make("b", { dismissedAt: "2025-05-22T17:00:00.000Z" }))).toBe(false);
    const future = new Date(Date.now() + 60000).toISOString();
    const past = new Date(Date.now() - 60000).toISOString();
    expect(isLive(make("c", { snoozedUntil: future }))).toBe(false);
    expect(isLive(make("d", { snoozedUntil: past }))).toBe(true);
  });

  test("unread/read counts only consider live items", () => {
    const items = [
      make("1", { read: false }),
      make("2", { read: true }),
      make("3", { read: false, dismissedAt: "2025-05-22T17:00:00.000Z" }),
    ];
    expect(unreadCount(items)).toBe(1);
    expect(readCount(items)).toBe(1);
    expect(liveNotifications(items)).toHaveLength(2);
  });

  test("severityCounts tallies live items per severity", () => {
    const items = [
      make("1", { severity: "crit" }),
      make("2", { severity: "warn" }),
      make("3", { severity: "warn" }),
      make("4", { severity: "info" }),
    ];
    expect(severityCounts(items)).toEqual({ all: 4, crit: 1, warn: 2, info: 1 });
  });
});

describe("notifications/derive · filter, sort, group", () => {
  test("filterNotifications narrows by severity and free-text query", () => {
    const items = [
      make("1", { severity: "crit", title: "Refund rate above norm" }),
      make("2", { severity: "warn", title: "Labor over target" }),
      make("3", { severity: "info", title: "Daily summary" }),
    ];
    expect(filterNotifications(items, "warn", "").map((n) => n.id)).toEqual(["2"]);
    expect(filterNotifications(items, "all", "refund").map((n) => n.id)).toEqual(["1"]);
    expect(filterNotifications(items, "all", "nothing-matches")).toHaveLength(0);
  });

  test("compareSeverity orders critical first", () => {
    const order: Severity[] = ["info", "crit", "warn"];
    const sorted = order.map((s, i) => make(String(i), { severity: s })).sort(compareSeverity);
    expect(sorted.map((n) => n.severity)).toEqual(["crit", "warn", "info"]);
  });

  test("groupByTime keeps canonical order and drops empty groups", () => {
    const items = [
      make("1", { group: "Earlier this week" }),
      make("2", { group: "Today" }),
    ];
    expect(groupByTime(items).map((g) => g.label)).toEqual(["Today", "Earlier this week"]);
  });
});
