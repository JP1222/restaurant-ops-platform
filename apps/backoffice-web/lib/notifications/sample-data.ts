import type { Notification, NotificationPrefs } from "./types";

// ---------------------------------------------------------------------------
// SAMPLE DATA — stand-in for the events/notifications service (handoff TODO #1).
// Timestamps and labels are anchored to a fixed reference (Thu 2025-05-22) so the
// derived `group`/`timeLabel` are deterministic across server and client render.
// `group` and `timeLabel` are pre-resolved here (a real API would send them too,
// or the client would derive them via lib/notifications/derive on fetch).
// ---------------------------------------------------------------------------

export const SAMPLE_NOTIFICATIONS: Notification[] = [
  {
    id: "1",
    severity: "crit",
    category: "sales",
    categoryLabel: "Sales",
    icon: "trending-down",
    title: "Refund rate above norm",
    detail:
      "Refunds at 1.8% of net sales vs 1.1% typical — three on Spicy Tuna in the last hour, all delivery.",
    createdAt: "2025-05-22T19:06:00.000Z",
    group: "Today",
    timeLabel: "8m",
    read: false,
    action: { label: "View in Trends", icon: "trending-up", href: "/trends" },
    ai: {
      text: "5 of 6 refunds flag “item not fresh” and all land between 12:40–14:10 delivery orders; dine-in had zero. Looks like a hand-off or transit temperature issue, not the recipe. Check ticket-to-handoff times for that window first.",
      block: {
        kind: "bars",
        label: "Chart",
        title: "Refunds by hour",
        caption: "6 refunds in 2 hours · ~1/hr is typical",
        cols: [
          { label: "11 AM", value: "0", ratio: 0 },
          { label: "12 PM", value: "1", ratio: 1 / 3 },
          { label: "1 PM", value: "2", ratio: 2 / 3, emphasis: true },
          { label: "2 PM", value: "3", ratio: 1, emphasis: true },
        ],
      },
    },
  },
  {
    id: "2",
    severity: "crit",
    category: "inv",
    categoryLabel: "Inventory",
    icon: "package",
    title: "Salmon projected to 86 by 7 PM",
    detail:
      "On-hand is below par. At today's pace it hits zero around 7:05 PM. Reorder is queued with the vendor.",
    createdAt: "2025-05-22T18:52:00.000Z",
    group: "Today",
    timeLabel: "22m",
    read: false,
    action: { label: "View inventory", icon: "package", href: "/inventory" },
    ai: {
      text: "Burn rate is ~3.2 lb/hr; two reservations tonight ordered the salmon set. Consider de-prioritizing salmon items on the display or flag the kitchen to portion-control.",
      block: {
        kind: "action",
        label: "Suggested action",
        icon: "eye-off",
        title: "Hide salmon items on customer display",
        hint: "Until the 5:30 PM restock lands — protects the 7 PM rush.",
        action: {
          id: "hide-salmon-display",
          applyLabel: "Apply",
          confirmPrompt: "This updates the live customer display. Confirm?",
          doneLabel: "Applied · salmon hidden on display",
          endpoint: "/api/admin/board-settings",
          idempotencyKey: "notif-2-hide-salmon",
        },
      },
    },
  },
  {
    id: "3",
    severity: "warn",
    category: "dev",
    categoryLabel: "Devices",
    icon: "monitor-x",
    title: "KDS-2 offline for 12 min",
    detail:
      "Second kitchen screen dropped. Backoffice can't read its live status — details in System Health.",
    createdAt: "2025-05-22T18:43:00.000Z",
    group: "Today",
    timeLabel: "31m",
    read: false,
    action: { label: "Open System Health", icon: "external-link", href: "/ops" },
    ai: {
      text: "Last heartbeat at 14:18, coincident with a back-kitchen router restart. The other two screens are healthy and expo isn't affected. These usually recover on reconnect — watch for now.",
    },
  },
  {
    id: "4",
    severity: "warn",
    category: "cost",
    categoryLabel: "Ops",
    icon: "users",
    title: "Labor 4pts over target",
    detail:
      "Labor at 28% of net sales vs 24% target. The 3–5 PM shift is overstaffed for current traffic.",
    createdAt: "2025-05-22T18:14:00.000Z",
    group: "Today",
    timeLabel: "1h",
    read: true,
    action: { label: "View in Costs", icon: "scale", href: "/costs" },
    ai: {
      text: "Overage is the 15:00–17:00 lull with 4 on the floor; today's traffic supports 2–3. Trimming one brings it back to the 24% line.",
      block: {
        kind: "compare",
        label: "Comparison",
        title: "Labor % of net sales",
        caption: "Overage sits in the 3–5 PM lull",
        rows: [
          { label: "Actual", value: "28%", ratio: 28 / 32, tone: "warn" },
          { label: "Target", value: "24%", ratio: 24 / 32, tone: "neutral" },
        ],
      },
    },
  },
  {
    id: "5",
    severity: "warn",
    category: "cost",
    categoryLabel: "Costs",
    icon: "trending-down",
    title: "Dragon Roll margin at 58%",
    detail:
      "Avocado cost rose; this item's margin slid from 64% to 58%, under the 60% target.",
    createdAt: "2025-05-22T17:14:00.000Z",
    group: "Today",
    timeLabel: "2h",
    read: true,
    action: { label: "View in Costs", icon: "scale", href: "/costs" },
    ai: {
      text: "Avocado landed cost moved $1.10 → $1.48 per portion, the main driver. California Roll uses less and is barely affected. Consider a small price or portion adjustment on Dragon Roll.",
      block: {
        kind: "steps",
        label: "Options",
        title: "Two ways to recover margin",
        items: [
          { text: "Raise Dragon Roll $1.00 → back to ~62% margin" },
          { text: "Trim 0.5 oz avocado per roll → ~61% margin" },
        ],
      },
    },
  },
  {
    id: "6",
    severity: "info",
    category: "intg",
    categoryLabel: "Integrations",
    icon: "plug",
    title: "Clover sync retried ×2",
    detail:
      "Two overnight heartbeats timed out and auto-recovered. Retry manually from Integrations if it recurs.",
    createdAt: "2025-05-22T17:04:00.000Z",
    group: "Today",
    timeLabel: "2h",
    read: true,
    action: { label: "View integrations", icon: "external-link", href: "/settings/integrations" },
    ai: {
      text: "Both failures (03:12, 03:40) fell inside Clover's nightly maintenance window; the system backfilled automatically with no data loss. No action needed.",
    },
  },
  {
    id: "7",
    severity: "info",
    category: "sales",
    categoryLabel: "Sales",
    icon: "file-text",
    title: "Daily sales summary ready",
    detail:
      "Net sales $5,140 · 186 orders · $27.60 avg ticket. Full close-out report is generated.",
    createdAt: "2025-05-21T21:00:00.000Z",
    group: "Yesterday",
    timeLabel: "Yesterday",
    read: true,
    action: { label: "View summary", icon: "file-text", href: "/today" },
    ai: {
      text: "Net sales +3.2% vs the prior day, delivery share 38%, avg ticket up $0.40. The full report breaks down by daypart and channel.",
      block: {
        kind: "bars",
        label: "Chart",
        title: "Net sales by channel",
        caption: "Delivery share 38% · avg ticket $27.60",
        cols: [
          { label: "Dine-in", value: "$3.2k", ratio: 3186 / 3400 },
          { label: "Delivery", value: "$2.0k", ratio: 1954 / 3400, emphasis: true },
        ],
      },
    },
  },
  {
    id: "8",
    severity: "info",
    category: "inv",
    categoryLabel: "Inventory",
    icon: "truck",
    title: "Received California Roll restock",
    detail: "18 lb logged by crew on the receiving screen. Par status is back to normal.",
    createdAt: "2025-05-21T16:00:00.000Z",
    group: "Yesterday",
    timeLabel: "Yesterday",
    read: true,
    action: { label: "View inventory", icon: "package", href: "/inventory" },
    ai: {
      text: "18 lb is in; on-hand is now ~110% of par, enough to cover through close at today's pace.",
    },
  },
  {
    id: "9",
    severity: "info",
    category: "sales",
    categoryLabel: "Sales",
    icon: "trending-up",
    title: "Net sales +6% week over week",
    detail:
      "Last week's net sales rose 6% vs the prior week, driven mostly by the delivery channel.",
    createdAt: "2025-05-19T15:00:00.000Z",
    group: "Earlier this week",
    timeLabel: "Mon",
    read: true,
    action: { label: "Open Compare", icon: "git-compare", href: "/compare" },
    ai: {
      text: "The +6% came from Friday and Saturday delivery dinners; dine-in was roughly flat. Compare by channel for the full split.",
      block: {
        kind: "metric",
        label: "Headline",
        value: "+6.0%",
        unit: "WoW",
        metricLabel: "Net sales, week over week",
        delta: "Delivery dinners Fri–Sat drove the gain",
        deltaTone: "up",
      },
    },
  },
  {
    id: "10",
    severity: "info",
    category: "intg",
    categoryLabel: "Integrations",
    icon: "plug-zap",
    title: "Deliverect reconnected",
    detail:
      "Recovered automatically after a 4-minute drop; orders during the gap were backfilled.",
    createdAt: "2025-05-19T16:06:00.000Z",
    group: "Earlier this week",
    timeLabel: "Mon",
    read: true,
    action: { label: "View integrations", icon: "external-link", href: "/settings/integrations" },
    ai: {
      text: "The drop ran 11:02–11:06; 3 orders in that window were backfilled on reconnect with no loss.",
    },
  },
];

export const DEFAULT_PREFS: NotificationPrefs = {
  quiet: true,
  quietFrom: "10:00 PM",
  quietTo: "7:00 AM",
  cats: {
    sales: { label: "Sales", icon: "trending-up", inapp: true, email: true, push: true, sev: "warn" },
    inv: { label: "Inventory", icon: "package", inapp: true, email: false, push: true, sev: "warn" },
    dev: { label: "Devices", icon: "monitor", inapp: true, email: false, push: true, sev: "crit" },
    cost: { label: "Costs & Ops", icon: "dollar-sign", inapp: true, email: true, push: false, sev: "warn" },
    intg: { label: "Integrations", icon: "plug", inapp: true, email: false, push: false, sev: "crit" },
  },
};
