import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn() }) }));

// vi.hoisted so the mock object exists before the hoisted vi.mock factory runs.
const bff = vi.hoisted(() => ({
  list: vi.fn(),
  getPrefs: vi.fn(),
  markRead: vi.fn(async () => {}),
  dismiss: vi.fn(async () => {}),
  snooze: vi.fn(async () => {}),
  readAll: vi.fn(async () => {}),
  archiveRead: vi.fn(async () => {}),
  updatePrefs: vi.fn(async () => {}),
  applyAction: vi.fn(async () => ({ status: "applied" as const, doneLabel: "Salmon roll 86'd" }))
}));
vi.mock("@/lib/notifications/api", () => ({ notificationsBff: bff }));

import { DEFAULT_PREFS } from "@/lib/notifications/sample-data";
import { useNotificationStore } from "@/stores/notifications";

function dto(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    severity: "crit" as const,
    category: "sales" as const,
    categoryLabel: "Sales",
    icon: "trending-down",
    title: `Title ${id}`,
    detail: "Detail",
    createdAt: "2025-05-22T19:06:00.000Z",
    read: false,
    action: { label: "View", icon: "trending-up", href: "/trends" },
    ...over
  };
}

beforeEach(() => {
  useNotificationStore.setState({
    items: [],
    prefs: structuredClone(DEFAULT_PREFS),
    live: false,
    expandedAiIds: [],
    appliedActionIds: [],
    confirmingActionId: null
  });
  for (const fn of Object.values(bff)) fn.mockClear();
});

describe("hydrate", () => {
  it("maps DTOs to the view-model (derives group + timeLabel) and flips live on", () => {
    useNotificationStore.getState().hydrate([dto("1")]);
    const s = useNotificationStore.getState();
    expect(s.live).toBe(true);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ id: "1", severity: "crit" });
    expect(s.items[0]?.timeLabel).toBeTypeOf("string");
    expect(s.items[0]?.group).toBeTruthy();
  });
});

describe("write-through gating", () => {
  it("does NOT call the BFF in sample mode (live=false)", () => {
    useNotificationStore.setState({ items: [{ ...dto("1"), group: "Today", timeLabel: "8m" }], live: false });
    useNotificationStore.getState().markRead("1");
    expect(bff.markRead).not.toHaveBeenCalled();
  });

  it("writes a row mutation through when live", () => {
    useNotificationStore.getState().hydrate([dto("1")]);
    useNotificationStore.getState().markRead("1");
    expect(bff.markRead).toHaveBeenCalledWith("1");
  });

  it("writes a minimal prefs patch through when live", () => {
    useNotificationStore.getState().hydrate([]);
    useNotificationStore.getState().toggleQuiet();
    expect(bff.updatePrefs).toHaveBeenCalledTimes(1);
    // DEFAULT_PREFS.quiet is true, so toggling sends quiet:false.
    expect(bff.updatePrefs).toHaveBeenCalledWith({ quiet: false });
  });

  it("applyAction on a notification with no suggested action stays local (no BFF call)", () => {
    useNotificationStore.getState().hydrate([dto("1")]); // no ai/action block
    useNotificationStore.getState().applyAction("1");
    expect(useNotificationStore.getState().appliedActionIds).toContain("1");
    expect(bff.applyAction).not.toHaveBeenCalled();
  });

  it("writes an apply-action through when live (idempotency-keyed)", () => {
    const action = {
      id: "hide-salmon",
      applyLabel: "86 it",
      confirmPrompt: "86 the salmon roll?",
      doneLabel: "Salmon roll 86'd",
      endpoint: "/api/notifications/act-1/actions/apply",
      idempotencyKey: "notif-act-1-hide-salmon"
    };
    useNotificationStore.getState().hydrate([
      dto("act-1", {
        ai: {
          text: "Out of stock.",
          block: { kind: "action", label: "Suggested action", icon: "zap", title: "t", hint: "h", action }
        }
      })
    ]);
    useNotificationStore.getState().applyAction("act-1");
    expect(useNotificationStore.getState().appliedActionIds).toContain("act-1");
    expect(bff.applyAction).toHaveBeenCalledWith({
      notificationId: "act-1",
      actionId: "hide-salmon",
      idempotencyKey: "notif-act-1-hide-salmon"
    });
  });
});
