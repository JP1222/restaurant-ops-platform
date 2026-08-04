import type { Notification } from "@rop/contracts";
import { describe, expect, it, vi } from "vitest";

import { NotificationBus } from "../src/lib/event-bus.js";

function fakeNotification(id: string): Notification {
  return {
    id,
    severity: "info",
    category: "sales",
    categoryLabel: "Sales",
    icon: "trending-up",
    title: `Title ${id}`,
    detail: `Detail ${id}`,
    createdAt: "2025-05-22T17:00:00.000Z",
    read: false,
    snoozedUntil: null,
    dismissedAt: null,
    action: { label: "Open", icon: "external-link", href: "/today" }
  };
}

describe("NotificationBus", () => {
  it("fans a published notification out to every subscriber", () => {
    const bus = new NotificationBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe(a);
    bus.subscribe(b);

    const n = fakeNotification("1");
    bus.publish(n);

    expect(a).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenCalledWith(n);
    expect(b).toHaveBeenCalledTimes(1);
    expect(bus.subscriberCount()).toBe(2);
  });

  it("stops delivering after unsubscribe, with no leaked listener (disconnect path)", () => {
    const bus = new NotificationBus();
    const listener = vi.fn();
    const unsubscribe = bus.subscribe(listener);

    bus.publish(fakeNotification("1"));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(bus.subscriberCount()).toBe(1);

    unsubscribe();
    expect(bus.subscriberCount()).toBe(0);

    bus.publish(fakeNotification("2"));
    expect(listener).toHaveBeenCalledTimes(1); // not delivered after unsubscribe
  });

  it("publishing with no subscribers is a no-op (ingest never blocks on fanout)", () => {
    const bus = new NotificationBus();
    expect(() => bus.publish(fakeNotification("1"))).not.toThrow();
    expect(bus.subscriberCount()).toBe(0);
  });
});
