import { beforeEach, describe, expect, test, vi } from "vitest";
import { liveNotifications, readCount, unreadCount } from "@/lib/notifications/derive";
import { DEFAULT_PREFS, SAMPLE_NOTIFICATIONS } from "@/lib/notifications/sample-data";
import { useNotificationStore } from "@/stores/notifications";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn() }) }));

function items() {
  return useNotificationStore.getState().items;
}

beforeEach(() => {
  useNotificationStore.setState({
    items: SAMPLE_NOTIFICATIONS.map((n) => ({ ...n })),
    prefs: structuredClone(DEFAULT_PREFS),
    bellOpen: false,
    bellTab: "unread",
    filter: "all",
    query: "",
    expandedAiIds: [],
    confirmingActionId: null,
    appliedActionIds: [],
  });
});

describe("notifications store · read state", () => {
  test("seed has three unread, all live", () => {
    expect(unreadCount(items())).toBe(3);
    expect(liveNotifications(items())).toHaveLength(10);
  });

  test("markRead clears a single unread; markAllRead clears the rest", () => {
    useNotificationStore.getState().markRead("1");
    expect(unreadCount(items())).toBe(2);
    useNotificationStore.getState().markAllRead();
    expect(unreadCount(items())).toBe(0);
  });

  test("toggleAi expands the row and marks it read", () => {
    useNotificationStore.getState().toggleAi("1");
    expect(useNotificationStore.getState().expandedAiIds).toContain("1");
    expect(items().find((n) => n.id === "1")?.read).toBe(true);
    useNotificationStore.getState().toggleAi("1");
    expect(useNotificationStore.getState().expandedAiIds).not.toContain("1");
  });
});

describe("notifications store · dismiss, snooze, archive", () => {
  test("dismiss removes an item from the live list", () => {
    useNotificationStore.getState().dismiss("1");
    expect(liveNotifications(items())).toHaveLength(9);
    expect(unreadCount(items())).toBe(2);
  });

  test("snooze hides the item while the window is active", () => {
    useNotificationStore.getState().snooze("2");
    expect(liveNotifications(items()).some((n) => n.id === "2")).toBe(false);
    expect(unreadCount(items())).toBe(2);
  });

  test("archiveRead dismisses every read item, leaving unread", () => {
    useNotificationStore.getState().archiveRead();
    const live = liveNotifications(items());
    expect(live).toHaveLength(3);
    expect(readCount(items())).toBe(0);
    expect(live.every((n) => !n.read)).toBe(true);
  });
});

describe("notifications store · suggested action confirm", () => {
  test("start → apply records the applied action and clears confirming", () => {
    const store = useNotificationStore.getState();
    store.startConfirm("2");
    expect(useNotificationStore.getState().confirmingActionId).toBe("2");
    store.applyAction("2");
    expect(useNotificationStore.getState().confirmingActionId).toBeNull();
    expect(useNotificationStore.getState().appliedActionIds).toContain("2");
  });

  test("cancel clears the confirm without applying", () => {
    const store = useNotificationStore.getState();
    store.startConfirm("2");
    store.cancelConfirm();
    expect(useNotificationStore.getState().confirmingActionId).toBeNull();
    expect(useNotificationStore.getState().appliedActionIds).not.toContain("2");
  });
});

describe("notifications store · preferences", () => {
  test("togglePrefChannel flips a single channel", () => {
    const before = useNotificationStore.getState().prefs.cats.sales.email;
    useNotificationStore.getState().togglePrefChannel("sales", "email");
    expect(useNotificationStore.getState().prefs.cats.sales.email).toBe(!before);
  });

  test("cyclePrefSeverity advances all → warn → crit → all", () => {
    useNotificationStore.setState((s) => ({
      prefs: { ...s.prefs, cats: { ...s.prefs.cats, sales: { ...s.prefs.cats.sales, sev: "all" } } },
    }));
    const cycle = useNotificationStore.getState().cyclePrefSeverity;
    cycle("sales");
    expect(useNotificationStore.getState().prefs.cats.sales.sev).toBe("warn");
    cycle("sales");
    expect(useNotificationStore.getState().prefs.cats.sales.sev).toBe("crit");
    cycle("sales");
    expect(useNotificationStore.getState().prefs.cats.sales.sev).toBe("all");
  });

  test("toggleQuiet flips quiet hours", () => {
    const before = useNotificationStore.getState().prefs.quiet;
    useNotificationStore.getState().toggleQuiet();
    expect(useNotificationStore.getState().prefs.quiet).toBe(!before);
  });
});
