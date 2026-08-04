import { create } from "zustand";
import { toast } from "sonner";
import type { Notification as NotificationDto, NotificationPrefs } from "@rop/contracts";
import { deriveGroup, deriveTimeLabel, type SeverityFilter } from "@/lib/notifications/derive";
import { liveNotifications } from "@/lib/notifications/derive";
import { MIN_SEVERITY_CYCLE } from "@/lib/notifications/meta";
import { notificationsBff } from "@/lib/notifications/api";
import { DEFAULT_PREFS, SAMPLE_NOTIFICATIONS } from "@/lib/notifications/sample-data";
import type {
  Category,
  Notification,
  NotificationChannel,
  NotificationPrefs as ViewPrefs
} from "@/lib/notifications/types";

const SNOOZE_MS = 60 * 60 * 1000;

// Single shared list + preferences. Every surface (bell, inbox, sidebar badge,
// preferences) reads and mutates this store, so read/dismiss/snooze/apply stay
// in sync everywhere. It seeds from sample-data and works fully offline (sample
// mode). When the BFF reports the service is connected, NotificationsBoot
// hydrates it from the server (`live = true`) and mutations write through to the
// BFF — the periodic refetch reconciles any drift. See ADR-0801 (Phase 3).
interface NotificationStore {
  items: Notification[];
  prefs: ViewPrefs;
  /** True once hydrated from a connected notifications-api; gates write-through. */
  live: boolean;

  bellOpen: boolean;
  bellTab: "unread" | "all";

  filter: SeverityFilter;
  query: string;
  expandedAiIds: string[];

  confirmingActionId: string | null;
  appliedActionIds: string[];

  setLive: (live: boolean) => void;
  hydrate: (notifications: NotificationDto[]) => void;
  hydratePrefs: (prefs: NotificationPrefs) => void;

  setBellOpen: (open: boolean) => void;
  setBellTab: (tab: "unread" | "all") => void;
  setFilter: (filter: SeverityFilter) => void;
  setQuery: (query: string) => void;
  toggleAi: (id: string) => void;

  markRead: (id: string) => void;
  markAllRead: () => void;
  dismiss: (id: string) => void;
  archiveRead: () => void;
  snooze: (id: string) => void;

  startConfirm: (id: string) => void;
  cancelConfirm: () => void;
  applyAction: (id: string) => void;

  togglePrefChannel: (cat: Category, channel: NotificationChannel) => void;
  cyclePrefSeverity: (cat: Category) => void;
  toggleQuiet: () => void;
}

function patch(items: Notification[], id: string, fn: (n: Notification) => Notification): Notification[] {
  return items.map((n) => (n.id === id ? fn(n) : n));
}

// Contract DTO → view-model: the wire shape carries createdAt; the relative
// timeLabel + Today/Yesterday/Earlier group are derived against the viewer clock.
function toViewModel(n: NotificationDto, now: Date): Notification {
  return { ...n, group: deriveGroup(n.createdAt, now), timeLabel: deriveTimeLabel(n.createdAt, now) };
}

export const useNotificationStore = create<NotificationStore>((set, get) => ({
  items: SAMPLE_NOTIFICATIONS,
  prefs: DEFAULT_PREFS,
  live: false,

  bellOpen: false,
  bellTab: "unread",

  filter: "all",
  query: "",
  expandedAiIds: [],

  confirmingActionId: null,
  appliedActionIds: [],

  setLive: (live) => set({ live }),
  hydrate: (notifications) => {
    const now = new Date();
    set({ items: notifications.map((n) => toViewModel(n, now)), live: true });
  },
  hydratePrefs: (prefs) => set({ prefs }),

  setBellOpen: (bellOpen) => set({ bellOpen }),
  setBellTab: (bellTab) => set({ bellTab }),
  setFilter: (filter) => set({ filter }),
  setQuery: (query) => set({ query }),

  toggleAi: (id) => {
    set((s) => ({
      items: patch(s.items, id, (n) => (n.read ? n : { ...n, read: true })),
      expandedAiIds: s.expandedAiIds.includes(id)
        ? s.expandedAiIds.filter((x) => x !== id)
        : [...s.expandedAiIds, id]
    }));
    if (get().live) void notificationsBff.markRead(id).catch(() => {});
  },

  markRead: (id) => {
    set((s) => ({ items: patch(s.items, id, (n) => ({ ...n, read: true })) }));
    if (get().live) void notificationsBff.markRead(id).catch(() => {});
  },

  markAllRead: () => {
    set((s) => ({ items: s.items.map((n) => ({ ...n, read: true })) }));
    if (get().live) void notificationsBff.readAll().catch(() => {});
    toast.success("All marked as read", { icon: null });
  },

  dismiss: (id) => {
    set((s) => ({ items: patch(s.items, id, (n) => ({ ...n, dismissedAt: new Date().toISOString() })) }));
    if (get().live) void notificationsBff.dismiss(id).catch(() => {});
    toast("Notification dismissed");
  },

  archiveRead: () => {
    const n = liveNotifications(get().items).filter((x) => x.read).length;
    set((s) => ({
      items: s.items.map((x) => (x.read ? { ...x, dismissedAt: new Date().toISOString() } : x))
    }));
    if (get().live) void notificationsBff.archiveRead().catch(() => {});
    toast(`${n} read archived`);
  },

  snooze: (id) => {
    const until = new Date(Date.now() + SNOOZE_MS).toISOString();
    set((s) => ({ items: patch(s.items, id, (n) => ({ ...n, snoozedUntil: until })) }));
    if (get().live) void notificationsBff.snooze(id, until).catch(() => {});
    toast("Snoozed for 1 hour");
  },

  startConfirm: (id) => set({ confirmingActionId: id }),
  cancelConfirm: () => set({ confirmingActionId: null }),
  // Optimistically close the confirm + flip the row to "applied". In live mode the
  // mutation writes through to the BFF (manager-gated + idempotent + audited there);
  // a server rejection rolls the optimistic apply back so the row can be retried.
  // Sample mode stays purely local.
  applyAction: (id) => {
    const item = get().items.find((n) => n.id === id);
    const action = item?.ai?.block?.kind === "action" ? item.ai.block.action : null;
    set((s) => ({
      confirmingActionId: null,
      appliedActionIds: s.appliedActionIds.includes(id) ? s.appliedActionIds : [...s.appliedActionIds, id]
    }));
    if (get().live && action) {
      notificationsBff
        .applyAction({ notificationId: id, actionId: action.id, idempotencyKey: action.idempotencyKey })
        .then((res) => toast.success(res.doneLabel || "Action applied", { icon: null }))
        .catch(() => {
          set((s) => ({ appliedActionIds: s.appliedActionIds.filter((x) => x !== id) }));
          toast.error("Couldn't apply the action");
        });
    } else {
      toast.success("Action applied", { icon: null });
    }
  },

  togglePrefChannel: (cat, channel) => {
    const next = !get().prefs.cats[cat][channel];
    set((s) => ({
      prefs: { ...s.prefs, cats: { ...s.prefs.cats, [cat]: { ...s.prefs.cats[cat], [channel]: next } } }
    }));
    if (get().live) void notificationsBff.updatePrefs({ cats: { [cat]: { [channel]: next } } }).catch(() => {});
  },

  cyclePrefSeverity: (cat) => {
    const current = get().prefs.cats[cat].sev;
    const next = MIN_SEVERITY_CYCLE[(MIN_SEVERITY_CYCLE.indexOf(current) + 1) % MIN_SEVERITY_CYCLE.length];
    set((s) => ({
      prefs: { ...s.prefs, cats: { ...s.prefs.cats, [cat]: { ...s.prefs.cats[cat], sev: next } } }
    }));
    if (get().live) void notificationsBff.updatePrefs({ cats: { [cat]: { sev: next } } }).catch(() => {});
  },

  toggleQuiet: () => {
    const next = !get().prefs.quiet;
    set((s) => ({ prefs: { ...s.prefs, quiet: next } }));
    if (get().live) void notificationsBff.updatePrefs({ quiet: next }).catch(() => {});
  }
}));
