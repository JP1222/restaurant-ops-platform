import { describe, expect, it } from "vitest";

import {
  AiBlockSchema,
  ApplyActionRequestSchema,
  NotificationPrefsSchema,
  NotificationSchema,
  SnoozeRequestSchema,
  UpdatePrefsRequestSchema
} from "./notifications.js";

const baseNotification = {
  id: "1",
  severity: "crit" as const,
  category: "sales" as const,
  categoryLabel: "Sales",
  icon: "trending-down",
  title: "Refund rate above norm",
  detail: "Refunds at 1.8% of net sales vs 1.1% typical.",
  createdAt: "2025-05-22T19:06:00.000Z",
  read: false,
  action: { label: "View in Trends", icon: "trending-up", href: "/trends" }
};

describe("NotificationSchema", () => {
  it("accepts a record without ai (lazy on expand) or interaction-state fields", () => {
    const parsed = NotificationSchema.parse(baseNotification);
    expect(parsed.ai).toBeUndefined();
    expect(parsed.snoozedUntil).toBeUndefined();
  });

  it("does NOT carry client-derived view fields (group / timeLabel)", () => {
    const parsed = NotificationSchema.parse({
      ...baseNotification,
      group: "Today",
      timeLabel: "8m"
    }) as Record<string, unknown>;
    expect(parsed.group).toBeUndefined();
    expect(parsed.timeLabel).toBeUndefined();
  });

  it("rejects a non-ISO createdAt", () => {
    expect(() => NotificationSchema.parse({ ...baseNotification, createdAt: "yesterday" })).toThrow();
  });

  it("rejects an unknown severity", () => {
    expect(() => NotificationSchema.parse({ ...baseNotification, severity: "urgent" })).toThrow();
  });
});

describe("AiBlockSchema", () => {
  it("narrows on kind and bounds a bars ratio to 0..1", () => {
    const bars = AiBlockSchema.parse({
      kind: "bars",
      label: "Chart",
      title: "Refunds by hour",
      caption: "6 refunds in 2 hours",
      cols: [{ label: "2 PM", value: "3", ratio: 1, emphasis: true }]
    });
    expect(bars.kind).toBe("bars");
    expect(() =>
      AiBlockSchema.parse({
        kind: "bars",
        label: "Chart",
        title: "x",
        caption: "y",
        cols: [{ label: "a", value: "1", ratio: 1.4 }]
      })
    ).toThrow();
  });

  it("accepts an action block carrying an idempotency-keyed SuggestedAction", () => {
    const block = AiBlockSchema.parse({
      kind: "action",
      label: "Suggested action",
      icon: "eye-off",
      title: "Hide salmon items on customer display",
      hint: "Until the 5:30 PM restock lands.",
      action: {
        id: "hide-salmon-display",
        applyLabel: "Apply",
        confirmPrompt: "This updates the live customer display. Confirm?",
        doneLabel: "Applied · salmon hidden on display",
        endpoint: "/api/notifications/actions/hide-salmon-display",
        idempotencyKey: "notif-2-hide-salmon"
      }
    });
    expect(block.kind === "action" && block.action.idempotencyKey).toBe("notif-2-hide-salmon");
  });

  it("rejects a label/kind mismatch", () => {
    expect(() =>
      AiBlockSchema.parse({ kind: "metric", label: "Chart", value: "+6%", unit: "WoW", metricLabel: "x", delta: "y", deltaTone: "up" })
    ).toThrow();
  });
});

describe("preferences + mutation DTOs", () => {
  it("requires every category in the full prefs state", () => {
    const cat = (label: string, icon: string) => ({ label, icon, inapp: true, email: true, push: true, sev: "warn" as const });
    const full = {
      quiet: true,
      quietFrom: "10:00 PM",
      quietTo: "7:00 AM",
      cats: {
        sales: cat("Sales", "trending-up"),
        inv: cat("Inventory", "package"),
        dev: cat("Devices", "monitor"),
        cost: cat("Costs & Ops", "dollar-sign"),
        intg: cat("Integrations", "plug")
      }
    };
    expect(NotificationPrefsSchema.parse(full).quiet).toBe(true);
    expect(() => NotificationPrefsSchema.parse({ ...full, cats: { sales: full.cats.sales } })).toThrow();
  });

  it("lets an update patch a single category cell without sending the rest", () => {
    expect(UpdatePrefsRequestSchema.parse({ quiet: false }).quiet).toBe(false);
    const patch = UpdatePrefsRequestSchema.parse({ cats: { inv: { email: true } } });
    expect(patch.cats?.inv?.email).toBe(true);
  });

  it("requires an idempotency key on apply-action", () => {
    expect(() => ApplyActionRequestSchema.parse({ notificationId: "2", actionId: "hide-salmon-display" })).toThrow();
  });

  it("requires an ISO wake time on snooze", () => {
    expect(SnoozeRequestSchema.parse({ until: "2025-05-22T20:00:00.000Z" }).until).toBeTruthy();
    expect(() => SnoozeRequestSchema.parse({ until: "1 hour" })).toThrow();
  });
});
