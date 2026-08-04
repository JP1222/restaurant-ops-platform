"use client";

import { memo, startTransition, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import type {
  KdsTicket,
  KitchenBoardFilter,
  KitchenBoardSettings,
  RealtimeEvent,
  TicketSnapshot
} from "@rop/contracts";
import { TicketActionRequestSchema, TicketItemActionRequestSchema, TicketLocalEditRequestSchema } from "@rop/contracts";
import { apiJson, getWsBaseUrl } from "@/lib/api";
import { type AuthenticatedSession, type PasskeySummary } from "@/lib/auth";
import { createRealtimeCoalescer } from "@/lib/realtime-coalescer";
import {
  applyOptimisticBoardAction,
  applyOptimisticItemAction,
  countCompletedItems,
  defaultBoardVisualSettings,
  describeEditableOrderChannel,
  describeEditableFulfillmentTime,
  describeOrderChannel,
  displayDetailsForBoardItem,
  displayNameForBoardItem,
  formatElapsed,
  formatElapsedPrecise,
  getTicketUrgencyTier,
  getTicketElapsedSeconds,
  isBoardItemComplete,
  nextBoardItemAction,
  resolveBoardVisualSettings,
  sortTickets,
  summarizeBoard,
  toneForModifier,
  toneForOrderChannel
} from "@/lib/board";
import type { BoardVisualSettings, OptimisticBoardItemAction } from "@/lib/board";
import { DeliverectStatusCard } from "@/components/deliverect-status-card";
import { ManageInBackofficeLink } from "@/components/manage-in-backoffice-link";
import { SettingsAccessCard } from "@/components/settings-access-card";

type ConnectionState = "connecting" | "online" | "offline";
type DrawerView = "completed" | "settings" | null;
type BoardAction = "complete" | "recall";
type ChannelIconKind = "bag" | "car" | "dine" | "generic";
type LocalEditAction = "save" | "reset";
type TicketMutationAction = "delete";
type BoardScreenSettings = KitchenBoardSettings & BoardVisualSettings;
type PendingTicketAction = {
  action: BoardAction;
  occurredAt: string;
};
type PendingItemAction = {
  ticketId: string;
  itemKey: string;
  action: OptimisticBoardItemAction;
  occurredAt: string;
};
type ActionToast = {
  tone: "success" | "error";
  message: string;
};
type SnapshotRequiredEvent = {
  id?: string;
  type: "snapshot.required";
  merchantId: string;
  occurredAt: string;
  seq?: number;
  publishedAt?: string;
  reason: string;
};
type BoardRealtimeEvent = RealtimeEvent | SnapshotRequiredEvent;
type RealtimeBackfillResponse = {
  merchantId: string;
  fromSeq: number;
  toSeq: number;
  events: BoardRealtimeEvent[];
  snapshotRequired: boolean;
};
const boardStatusQuery = "new,on_hold,acknowledged,in_progress,ready,completed";
const realtimeFallbackPollMs = 5_000;
const realtimeHeartbeatMs = 20_000;
const realtimeHeartbeatTimeoutMs = 45_000;
const boardTimeZoneOptions = [
  { value: "America/Chicago", label: "Chicago (CT)" },
  { value: "America/New_York", label: "New York (ET)" },
  { value: "America/Denver", label: "Denver (MT)" },
  { value: "America/Los_Angeles", label: "Los Angeles (PT)" },
  { value: "UTC", label: "UTC" }
];
const emptyFilter: KitchenBoardFilter = {
  allowedOrderTypes: [],
  blockedSources: [],
  paymentStates: [],
  createdAfterMinutes: null,
  searchText: "",
  includeCompleted: false,
  soundEnabled: true,
  screenPinEnabled: false
};

function recordForValue(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function pickBoardVisualSettings(settings: BoardScreenSettings): BoardVisualSettings {
  return {
    urgencyWarningMinutes: settings.urgencyWarningMinutes,
    urgencyCriticalMinutes: settings.urgencyCriticalMinutes,
    urgencyBlinkCritical: settings.urgencyBlinkCritical,
    modifierDangerKeywords: settings.modifierDangerKeywords,
    modifierAccentKeywords: settings.modifierAccentKeywords
  };
}

function normalizeBoardSettings(
  settings: KitchenBoardSettings | Record<string, unknown> | null | undefined,
  fallbackTimeZone: string,
  fallbackVisual: BoardVisualSettings = defaultBoardVisualSettings
): BoardScreenSettings {
  const raw = recordForValue(settings);
  const filter = recordForValue(raw.filter);
  const visualSettings = resolveBoardVisualSettings({
    ...fallbackVisual,
    ...raw
  });

  return {
    ...createDefaultSettings(fallbackTimeZone),
    ...raw,
    providers: {
      deliverect: {
        ...createDefaultDeliverectSettings(),
        ...recordForValue(recordForValue(raw.providers).deliverect)
      }
    },
    filter: {
      ...emptyFilter,
      ...filter
    },
    display: normalizeDisplaySettings(raw.display),
    ...visualSettings
  } as BoardScreenSettings;
}

function itemActionKey(ticketId: string, itemKey: string) {
  return `${ticketId}:${itemKey}`;
}

function createDefaultDeliverectSettings(): KitchenBoardSettings["providers"]["deliverect"] {
  return {
    enabled: false,
    environment: "staging",
    externalLocationId: "",
    locationId: "",
    channelLinkId: "",
    apiToken: "",
    hmacSecret: "",
    registerWebhookStatus: null,
    ordersWebhookStatus: null,
    lastRegisterWebhookAt: null,
    lastOrderWebhookAt: null
  };
}

function createDefaultDisplaySettings(): KitchenBoardSettings["display"] {
  return {
    weather: {
      enabled: true,
      zipCode: "00000",
      countryCode: "US",
      unit: "fahrenheit"
    }
  };
}

function createDefaultSettings(boardTimeZone: string): BoardScreenSettings {
  return {
    filter: { ...emptyFilter },
    boardTimeZone,
    dailyResetEnabled: false,
    dailyResetTime: "21:00",
    reconcileIntervalSeconds: 45,
    ...defaultBoardVisualSettings,
    display: createDefaultDisplaySettings(),
    providers: {
      deliverect: createDefaultDeliverectSettings()
    }
  };
}

function normalizeDisplaySettings(value: unknown): KitchenBoardSettings["display"] {
  const defaults = createDefaultDisplaySettings();
  const display = recordForValue(value);
  const weather = recordForValue(display.weather);
  const unit = weather.unit === "celsius" ? "celsius" : "fahrenheit";

  return {
    weather: {
      ...defaults.weather,
      ...weather,
      enabled: typeof weather.enabled === "boolean" ? weather.enabled : defaults.weather.enabled,
      zipCode: typeof weather.zipCode === "string" && weather.zipCode.trim() ? weather.zipCode.trim() : defaults.weather.zipCode,
      countryCode: typeof weather.countryCode === "string" && weather.countryCode.trim() ? weather.countryCode.trim().toUpperCase() : defaults.weather.countryCode,
      unit
    }
  };
}

function createTimeFormatter(timeZone: string) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone
    });
  } catch {
    return new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "UTC"
    });
  }
}

function formatRailElapsedParts(minutes: number) {
  if (minutes < 60) {
    return [{ value: minutes, unit: "m" }];
  }

  return [
    { value: Math.floor(minutes / 60), unit: "h" },
    { value: minutes % 60, unit: "m" }
  ];
}

function mergeSnapshotTicket(current: TicketSnapshot, ticket: KdsTicket, serverTime = current.serverTime): TicketSnapshot {
  const nextTickets = new Map(current.tickets.map((currentTicket) => [currentTicket.id, currentTicket]));
  nextTickets.set(ticket.id, ticket);

  return {
    ...current,
    serverTime,
    tickets: sortTickets([...nextTickets.values()])
  };
}

function formatTicketTime(formatter: Intl.DateTimeFormat, value: string) {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return "--:--";
  }

  return formatter.format(timestamp);
}

function iconForOrderChannel(label: string): ChannelIconKind {
  const source = label.toLowerCase();

  if (source.includes("drive")) {
    return "car";
  }

  if (source.includes("for here") || source.includes("dine") || source.includes("table")) {
    return "dine";
  }

  if (source.includes("pickup") || source.includes("delivery") || source.includes("takeout") || source.includes("to-go")) {
    return "bag";
  }

  return "generic";
}

function ChannelIcon({ kind }: { kind: ChannelIconKind }) {
  switch (kind) {
    case "car":
      return (
        <svg className="service-chip-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M5 11l1.6-4.2A2 2 0 0 1 8.46 5.5h7.08a2 2 0 0 1 1.86 1.3L19 11" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M4.5 11.5h15a1.5 1.5 0 0 1 1.5 1.5v3a1 1 0 0 1-1 1h-1.25a.75.75 0 0 1-.75-.75V15H6v1.25a.75.75 0 0 1-.75.75H4a1 1 0 0 1-1-1v-3a1.5 1.5 0 0 1 1.5-1.5Z" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="7.5" cy="15.5" r="1" fill="currentColor" stroke="none" />
          <circle cx="16.5" cy="15.5" r="1" fill="currentColor" stroke="none" />
        </svg>
      );
    case "dine":
      return (
        <svg className="service-chip-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M6 4v7" strokeLinecap="round" />
          <path d="M9 4v7" strokeLinecap="round" />
          <path d="M6 7.5h3" strokeLinecap="round" />
          <path d="M7.5 11v9" strokeLinecap="round" />
          <path d="M16.5 4c-1.1 0-2 .9-2 2v4c0 1.1.9 2 2 2h.5v8" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M17 4v16" strokeLinecap="round" />
        </svg>
      );
    case "generic":
    case "bag":
      return (
        <svg className="service-chip-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M6 8h12l-.8 10.1a2 2 0 0 1-2 1.9H8.8a2 2 0 0 1-2-1.9L6 8Z" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M9.5 9V7a2.5 2.5 0 0 1 5 0v2" strokeLinecap="round" />
        </svg>
      );
  }
}

function SettingsIcon() {
  return (
    <svg className="settings-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
      <path
        d="M14.5 5.5a3 3 0 1 1 4 4L9 19l-4 1 1-4 8.5-8.5Z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="m13 7 4 4" strokeLinecap="round" />
      <path d="M3 21h18" strokeLinecap="round" />
    </svg>
  );
}

type LocalEditDraft = {
  ticketId: string;
  orderLabel: string;
  channelLabel: string;
  fulfillmentTimeLabel: string;
  note: string;
  hasLocalEdits: boolean;
};

function playTone() {
  if (typeof window === "undefined") {
    return;
  }

  const AudioContextCtor = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) {
    return;
  }

  const context = new AudioContextCtor();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "triangle";
  oscillator.frequency.value = 784;
  gain.gain.value = 0.08;
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + 0.18);
}

export function BoardScreen({
  initialMerchantId,
  initialBoardTimeZone,
  initialDrawer,
  authSession,
  initialPasskeys
}: {
  initialMerchantId: string;
  initialBoardTimeZone: string;
  initialDrawer: DrawerView;
  // Absent in device-pairing mode (ADR-0818 Phase-2b): a paired board has no user
  // session — the device token is the trust boundary. The manager settings card
  // (the only authSession consumer) is hidden when absent.
  authSession?: AuthenticatedSession;
  initialPasskeys: PasskeySummary[];
}) {
  const [merchantId] = useState(initialMerchantId);
  const [boardTimeZone, setBoardTimeZone] = useState(initialBoardTimeZone);
  const [snapshot, setSnapshot] = useState<TicketSnapshot | null>(null);
  const [settings, setSettings] = useState<BoardScreenSettings>(() => createDefaultSettings(initialBoardTimeZone));
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [demoSeeding, setDemoSeeding] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionToast, setActionToast] = useState<ActionToast | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [muted, setMuted] = useState(false);
  const [drawer, setDrawer] = useState<DrawerView>(initialDrawer);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [pendingActions, setPendingActions] = useState<Partial<Record<string, PendingTicketAction>>>({});
  const [pendingItemActions, setPendingItemActions] = useState<Record<string, PendingItemAction>>({});
  const [localEditDraft, setLocalEditDraft] = useState<LocalEditDraft | null>(null);
  const [localEditAction, setLocalEditAction] = useState<LocalEditAction | null>(null);
  const [openTicketMenuId, setOpenTicketMenuId] = useState<string | null>(null);
  const [ticketMutation, setTicketMutation] = useState<{ action: TicketMutationAction; ticketId: string } | null>(null);
  const lastServerTime = useRef<string | null>(null);
  const lastRealtimeSeq = useRef(0);
  const realtimeBackfillInFlight = useRef(false);
  const deferredRealtimeEvents = useRef<BoardRealtimeEvent[]>([]);
  const realtimeCoalescer = useRef<ReturnType<typeof createRealtimeCoalescer<RealtimeEvent>> | null>(null);
  const reconnectTimer = useRef<number | null>(null);
  const reportedRealtimeReceiptIds = useRef<Set<string>>(new Set());
  const timeFormatter = useMemo(() => createTimeFormatter(boardTimeZone), [boardTimeZone]);
  const visualSettings = useMemo(() => resolveBoardVisualSettings(settings), [settings]);
  const pendingItemActionsByTicket = useMemo(() => {
    const next = new Map<string, PendingItemAction[]>();

    for (const action of Object.values(pendingItemActions)) {
      const current = next.get(action.ticketId);
      if (current) {
        current.push(action);
      } else {
        next.set(action.ticketId, [action]);
      }
    }

    return next;
  }, [pendingItemActions]);
  const pendingItemKeysByTicket = useMemo(() => {
    const next = new Map<string, Set<string>>();

    for (const action of Object.values(pendingItemActions)) {
      const current = next.get(action.ticketId);
      if (current) {
        current.add(action.itemKey);
      } else {
        next.set(action.ticketId, new Set([action.itemKey]));
      }
    }

    return next;
  }, [pendingItemActions]);

  function hasPendingMutation(ticketId: string) {
    return Boolean(pendingActions[ticketId]) || pendingItemActionsByTicket.has(ticketId);
  }

  function applyPendingMutations(ticket: KdsTicket) {
    let nextTicket = ticket;
    const pendingTicketAction = pendingActions[ticket.id];
    if (pendingTicketAction) {
      nextTicket = applyOptimisticBoardAction(nextTicket, pendingTicketAction.action, pendingTicketAction.occurredAt);
    }

    const itemActions = pendingItemActionsByTicket.get(ticket.id) ?? [];
    for (const itemAction of itemActions) {
      nextTicket = applyOptimisticItemAction(nextTicket, itemAction.itemKey, itemAction.action, itemAction.occurredAt);
    }

    return nextTicket;
  }

  function updateVisualSettings(partial: Partial<BoardVisualSettings>) {
    setSettings((current) => ({
      ...current,
      ...resolveBoardVisualSettings({
        ...current,
        ...partial
      })
    }));
  }

  const loadSnapshot = useEffectEvent(async (since?: string) => {
    const query = new URLSearchParams();
    query.set("merchantId", merchantId);
    query.set("status", boardStatusQuery);
    if (since) {
      query.set("since", since);
    }

    const next = await apiJson<TicketSnapshot>(`/api/kds/tickets?${query.toString()}`);
    lastServerTime.current = next.serverTime;
    if (typeof next.serverSeq === "number") {
      lastRealtimeSeq.current = next.serverSeq;
    }
    startTransition(() => {
      setSnapshot((current) => {
        const nextTickets = next.tickets.map((ticket) => applyPendingMutations(ticket));
        if (!current) {
          return {
            ...next,
            tickets: sortTickets(nextTickets)
          };
        }

        if (!since) {
          const merged = new Map(nextTickets.map((ticket) => [ticket.id, ticket]));

          for (const ticket of current.tickets) {
            if (hasPendingMutation(ticket.id) && !merged.has(ticket.id)) {
              merged.set(ticket.id, ticket);
            }
          }

          return {
            ...next,
            tickets: sortTickets([...merged.values()])
          };
        }

        const merged = new Map(current.tickets.map((ticket) => [ticket.id, ticket]));
        for (const ticket of nextTickets) {
          merged.set(ticket.id, ticket);
        }

        return {
          ...next,
          tickets: sortTickets([...merged.values()])
        };
      });
      setError(null);
    });
  });

  const loadSettings = useEffectEvent(async () => {
    if (!merchantId) {
      return;
    }

    try {
      const next = await apiJson<BoardScreenSettings>(`/api/kds/settings?merchantId=${encodeURIComponent(merchantId)}`);
      const normalizedSettings = normalizeBoardSettings(next, boardTimeZone || initialBoardTimeZone);
      startTransition(() => {
        setSettings(normalizedSettings);
        setBoardTimeZone(normalizedSettings.boardTimeZone);
        setSnapshot((current) => (current ? { ...current, filter: normalizedSettings.filter } : current));
        setSettingsMessage(null);
      });
    } catch (cause) {
      setSettingsMessage(cause instanceof Error ? cause.message : "Failed to load settings.");
    }
  });

  useEffect(() => {
    setClockNow(snapshot?.serverTime ? Date.parse(snapshot.serverTime) : Date.now());
  }, [snapshot?.serverTime]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setClockNow((current) => current + 1_000);
    }, 1_000);

    return () => {
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!actionToast) {
      return;
    }

    const timer = window.setTimeout(() => {
      setActionToast(null);
    }, 3_000);

    return () => {
      window.clearTimeout(timer);
    };
  }, [actionToast]);

  useEffect(() => {
    if (!openTicketMenuId) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      if (!(event.target instanceof Element)) {
        return;
      }

      if (event.target.closest("[data-ticket-menu-root]")) {
        return;
      }

      setOpenTicketMenuId(null);
    }

    window.addEventListener("pointerdown", handlePointerDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [openTicketMenuId]);

  useEffect(() => {
    if (!drawer && !openTicketMenuId && !localEditDraft) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }

      if (localEditDraft) {
        if (!localEditAction) {
          setLocalEditDraft(null);
        }
        return;
      }

      if (openTicketMenuId) {
        setOpenTicketMenuId(null);
        return;
      }

      setDrawer(null);
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [drawer, localEditAction, localEditDraft, openTicketMenuId]);

  const applyRealtimeBatch = useEffectEvent((events: RealtimeEvent[]) => {
    setSnapshot((current) => {
      if (!current) {
        return current;
      }

      return events.reduce(
        (next, event) => mergeSnapshotTicket(next, applyPendingMutations(event.ticket), event.occurredAt),
        current
      );
    });
  });

  const applyRealtimeSideEffects = useEffectEvent((event: RealtimeEvent) => {
    setPendingActions((current) => {
      if (!current[event.ticket.id]) {
        return current;
      }

      const next = { ...current };
      delete next[event.ticket.id];
      return next;
    });

    if (event.type === "ticket.created" && !muted && snapshot?.filter.soundEnabled) {
      playTone();
    }
  });

  const reportRealtimeReceipt = useEffectEvent((event: RealtimeEvent) => {
    if (event.type !== "ticket.created" || !event.id || !event.trace?.webhookReceivedAt) {
      return;
    }

    if (reportedRealtimeReceiptIds.current.has(event.id)) {
      return;
    }
    reportedRealtimeReceiptIds.current.add(event.id);

    const browserReceivedAt = new Date().toISOString();
    const sendReceipt = () => {
      void apiJson("/api/internal/realtime-receipts", {
        method: "POST",
        body: JSON.stringify({
          eventId: event.id,
          merchantId: event.merchantId,
          ticketId: event.ticket.id,
          browserReceivedAt,
          renderCommittedAt: new Date().toISOString()
        })
      }).catch(() => undefined);
    };

    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(sendReceipt);
      });
      return;
    }

    window.setTimeout(sendReceipt, 0);
  });

  const applyRealtimeEvent = useEffectEvent((event: BoardRealtimeEvent) => {
    if (typeof event.seq === "number") {
      if (lastRealtimeSeq.current > 0 && event.seq > lastRealtimeSeq.current + 1) {
        if (realtimeBackfillInFlight.current) {
          deferredRealtimeEvents.current.push(event);
          return;
        }
        void backfillRealtimeEvents(lastRealtimeSeq.current);
        return;
      }
      if (event.seq <= lastRealtimeSeq.current) {
        return;
      }
      lastRealtimeSeq.current = event.seq;
    }

    if (event.type === "snapshot.required") {
      realtimeCoalescer.current?.cancel();
      void loadSnapshot();
      return;
    }

    applyRealtimeSideEffects(event);
    reportRealtimeReceipt(event);
    const coalescer = realtimeCoalescer.current;
    if (coalescer) {
      coalescer.push(event);
    } else {
      applyRealtimeBatch([event]);
    }
  });

  const backfillRealtimeEvents = useEffectEvent(async (afterSeq: number) => {
    if (!merchantId || realtimeBackfillInFlight.current) {
      return;
    }

    realtimeBackfillInFlight.current = true;
    try {
      let cursor = afterSeq;
      while (true) {
        const query = new URLSearchParams({
          merchantId,
          afterSeq: String(cursor)
        });
        const response = await apiJson<RealtimeBackfillResponse>(`/api/kds/events?${query.toString()}`);
        if (response.snapshotRequired) {
          realtimeCoalescer.current?.cancel();
          await loadSnapshot();
          return;
        }

        if (response.events.length === 0) {
          if (response.toSeq > cursor) {
            realtimeCoalescer.current?.cancel();
            await loadSnapshot();
          }
          return;
        }

        for (const event of response.events) {
          applyRealtimeEvent(event);
          if (typeof event.seq === "number") {
            cursor = Math.max(cursor, event.seq);
          }
        }

        if (cursor >= response.toSeq) {
          return;
        }
      }
    } catch {
      realtimeCoalescer.current?.cancel();
      await loadSnapshot();
    } finally {
      realtimeBackfillInFlight.current = false;
      const deferred = deferredRealtimeEvents.current.toSorted((left, right) => {
        const leftSeq = typeof left.seq === "number" ? left.seq : Number.MAX_SAFE_INTEGER;
        const rightSeq = typeof right.seq === "number" ? right.seq : Number.MAX_SAFE_INTEGER;
        return leftSeq - rightSeq;
      });
      deferredRealtimeEvents.current = [];
      for (const event of deferred) {
        applyRealtimeEvent(event);
      }
    }
  });

  useEffect(() => {
    realtimeCoalescer.current = createRealtimeCoalescer((events) => {
      applyRealtimeBatch(events);
    });

    return () => {
      realtimeCoalescer.current?.cancel();
      realtimeCoalescer.current = null;
    };
  }, [applyRealtimeBatch]);

  useEffect(() => {
    if (!merchantId) {
      return;
    }

    void loadSnapshot();
  }, [merchantId]);

  useEffect(() => {
    if (!merchantId) {
      return;
    }

    void loadSettings();
  }, [merchantId]);

  useEffect(() => {
    if (!merchantId) {
      setConnectionState("offline");
      setError("Missing merchantId. Add NEXT_PUBLIC_DEFAULT_MERCHANT_ID or open /board?merchantId=...");
      return;
    }

    let closed = false;
    let socket: WebSocket | null = null;
    let heartbeatTimer: number | null = null;
    let lastPongAt = Date.now();

    const clearHeartbeat = () => {
      if (heartbeatTimer !== null) {
        window.clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    };

    const startHeartbeat = () => {
      clearHeartbeat();
      lastPongAt = Date.now();
      heartbeatTimer = window.setInterval(() => {
        if (!socket || socket.readyState !== WebSocket.OPEN) {
          return;
        }

        if (Date.now() - lastPongAt > realtimeHeartbeatTimeoutMs) {
          socket.close();
          return;
        }

        socket.send("ping");
      }, realtimeHeartbeatMs);
    };

    const connect = () => {
      setConnectionState("connecting");
      socket = new WebSocket(`${getWsBaseUrl()}/ws?merchantId=${encodeURIComponent(merchantId)}`);

      socket.addEventListener("open", () => {
        setConnectionState("online");
        startHeartbeat();
      });

      socket.addEventListener("message", (message) => {
        if (typeof message.data !== "string") {
          return;
        }

        if (message.data === "pong") {
          lastPongAt = Date.now();
          return;
        }

        try {
          applyRealtimeEvent(JSON.parse(message.data) as BoardRealtimeEvent);
        } catch {
          setError("Received an invalid realtime payload.");
        }
      });

      socket.addEventListener("close", () => {
        clearHeartbeat();
        if (closed) {
          return;
        }

        setConnectionState("offline");
        reconnectTimer.current = window.setTimeout(() => {
          if (lastRealtimeSeq.current > 0) {
            void backfillRealtimeEvents(lastRealtimeSeq.current);
          } else {
            void loadSnapshot(lastServerTime.current ?? undefined);
          }
          connect();
        }, 2_000);
      });
    };

    connect();

    return () => {
      closed = true;
      clearHeartbeat();
      socket?.close();
      if (reconnectTimer.current) {
        window.clearTimeout(reconnectTimer.current);
      }
    };
  }, [merchantId]);

  useEffect(() => {
    if (!merchantId || connectionState === "online") {
      return;
    }

    const timer = window.setInterval(() => {
      if (lastRealtimeSeq.current > 0) {
        void backfillRealtimeEvents(lastRealtimeSeq.current);
      } else {
        void loadSnapshot(lastServerTime.current ?? undefined);
      }
    }, realtimeFallbackPollMs);

    return () => {
      window.clearInterval(timer);
    };
  }, [connectionState, merchantId]);

  const activeTickets = useMemo(
    () => (snapshot?.tickets ?? []).filter((ticket) => ticket.status !== "completed" && ticket.status !== "on_hold"),
    [snapshot?.tickets]
  );
  const completedTickets = useMemo(
    () =>
      (snapshot?.tickets ?? [])
        .filter((ticket) => ticket.status === "completed")
        .sort((a, b) => (b.updatedAt < a.updatedAt ? -1 : b.updatedAt > a.updatedAt ? 1 : 0)),
    [snapshot?.tickets]
  );
  const boardStats = useMemo(() => summarizeBoard(activeTickets), [activeTickets]);
  const currentClock = useMemo(() => timeFormatter.format(clockNow), [clockNow, timeFormatter]);
  const boardTimeZoneLabel = useMemo(() => {
    const known = boardTimeZoneOptions.find((option) => option.value === settings.boardTimeZone);
    return known ? known.label : settings.boardTimeZone;
  }, [settings.boardTimeZone]);
  const weatherSummary = useMemo(() => {
    const { enabled, zipCode, unit } = settings.display.weather;
    if (!enabled) {
      return "Off";
    }
    const unitLabel = unit === "celsius" ? "°C" : "°F";
    return `On · ZIP ${zipCode || "unset"} · ${unitLabel}`;
  }, [settings.display.weather]);
  const dailyResetSummary = useMemo(() => {
    if (!settings.dailyResetEnabled) {
      return "Off";
    }
    return `On · ${settings.dailyResetTime}`;
  }, [settings.dailyResetEnabled, settings.dailyResetTime]);

  async function runAction(ticketId: string, action: BoardAction) {
    if (pendingActions[ticketId]) {
      return;
    }

    const previousTicket = snapshot?.tickets.find((ticket) => ticket.id === ticketId) ?? null;
    const optimisticOccurredAt = new Date().toISOString();
    const pendingAction: PendingTicketAction = {
      action,
      occurredAt: optimisticOccurredAt
    };

    setError(null);
    setPendingActions((current) => ({
      ...current,
      [ticketId]: pendingAction
    }));

    if (previousTicket) {
      setSnapshot((current) => {
        if (!current) {
          return current;
        }

        return mergeSnapshotTicket(current, applyOptimisticBoardAction(previousTicket, action, optimisticOccurredAt), optimisticOccurredAt);
      });
    }

    try {
      const body = TicketActionRequestSchema.parse({
        action,
        actor: "Kitchen"
      });
      const response = await apiJson<RealtimeEvent>(`/api/kds/tickets/${ticketId}/actions`, {
        method: "POST",
        body: JSON.stringify(body)
      });
      applyRealtimeEvent(response);
      setActionToast({
        tone: "success",
        message: action === "complete" ? "Order completed." : "Order recalled."
      });
    } catch (cause) {
      if (previousTicket) {
        setSnapshot((current) => {
          if (!current) {
            return current;
          }

          return mergeSnapshotTicket(current, previousTicket);
        });
      }

      const message = cause instanceof Error ? cause.message : "Action failed.";
      setActionToast({
        tone: "error",
        message: action === "complete"
          ? `Complete failed: ${message}`
          : `Recall failed: ${message}`
      });
      void loadSnapshot();
    } finally {
      setPendingActions((current) => {
        if (!current[ticketId]) {
          return current;
        }

        const next = { ...current };
        delete next[ticketId];
        return next;
      });
    }
  }

  const handleComplete = useEffectEvent((ticketId: string) => {
    void runAction(ticketId, "complete");
  });
  const handleRecall = useEffectEvent((ticketId: string) => {
    void runAction(ticketId, "recall");
  });
  async function runItemAction(ticketId: string, itemKey: string) {
    const key = itemActionKey(ticketId, itemKey);
    if (pendingActions[ticketId] || pendingItemActions[key]) {
      return;
    }

    const previousTicket = snapshot?.tickets.find((ticket) => ticket.id === ticketId) ?? null;
    const previousItem = previousTicket?.items.find((item) => item.itemKey === itemKey) ?? null;
    if (!previousTicket || !previousItem) {
      return;
    }

    const action = nextBoardItemAction(previousItem);
    const optimisticOccurredAt = new Date().toISOString();
    const pendingItemAction: PendingItemAction = {
      ticketId,
      itemKey,
      action,
      occurredAt: optimisticOccurredAt
    };

    setError(null);
    setPendingItemActions((current) => ({
      ...current,
      [key]: pendingItemAction
    }));

    setSnapshot((current) => {
      if (!current) {
        return current;
      }

      return mergeSnapshotTicket(current, applyOptimisticItemAction(previousTicket, itemKey, action, optimisticOccurredAt), optimisticOccurredAt);
    });

    try {
      const body = TicketItemActionRequestSchema.parse({
        action,
        actor: "Kitchen"
      });
      const response = await apiJson<RealtimeEvent>(`/api/kds/tickets/${ticketId}/items/${encodeURIComponent(itemKey)}/actions`, {
        method: "POST",
        body: JSON.stringify(body)
      });
      applyRealtimeEvent(response);
    } catch (cause) {
      setSnapshot((current) => {
        if (!current) {
          return current;
        }

        return mergeSnapshotTicket(current, previousTicket);
      });
      setError(cause instanceof Error ? cause.message : "Item action failed.");
      void loadSnapshot();
    } finally {
      setPendingItemActions((current) => {
        if (!current[key]) {
          return current;
        }

        const next = { ...current };
        delete next[key];
        return next;
      });
    }
  }
  const handleToggleItem = useEffectEvent((ticketId: string, itemKey: string) => {
    void runItemAction(ticketId, itemKey);
  });
  const handleOpenLocalEdit = useEffectEvent((ticket: KdsTicket) => {
    setOpenTicketMenuId(null);
    setLocalEditDraft({
      ticketId: ticket.id,
      orderLabel: ticket.orderLabel,
      channelLabel: describeEditableOrderChannel(ticket),
      fulfillmentTimeLabel: describeEditableFulfillmentTime(ticket),
      note: ticket.note ?? "",
      hasLocalEdits: ticket.hasLocalEdits
    });
  });

  const handleToggleTicketMenu = useEffectEvent((ticketId: string) => {
    setOpenTicketMenuId((current) => current === ticketId ? null : ticketId);
  });

  const handleCloseTicketMenu = useEffectEvent(() => {
    setOpenTicketMenuId(null);
  });

  async function deleteTicketLocally(ticket: KdsTicket) {
    if (ticketMutation || pendingActions[ticket.id] || pendingItemActionsByTicket.has(ticket.id)) {
      return;
    }

    const confirmed = typeof window === "undefined"
      ? true
      : window.confirm(`Delete ${ticket.orderLabel} from this board? This only removes the local copy and does not notify Clover.`);

    if (!confirmed) {
      return;
    }

    setError(null);
    setOpenTicketMenuId(null);
    setTicketMutation({
      action: "delete",
      ticketId: ticket.id
    });
    setSnapshot((current) => current ? {
      ...current,
      tickets: current.tickets.filter((currentTicket) => currentTicket.id !== ticket.id)
    } : current);

    try {
      await apiJson<{ ok: true; merchantId: string; orderId: string; ticketId: string }>(`/api/kds/tickets/${ticket.id}`, {
        method: "DELETE"
      });
      setActionToast({
        tone: "success",
        message: "Ticket deleted locally."
      });
      await loadSnapshot();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Failed to delete ticket.";
      setActionToast({
        tone: "error",
        message: `Delete failed: ${message}`
      });
      void loadSnapshot();
    } finally {
      setTicketMutation((current) => current?.ticketId === ticket.id ? null : current);
    }
  }

  async function saveLocalEditDraft() {
    if (!localEditDraft) {
      return;
    }

    setLocalEditAction("save");
    setError(null);

    try {
      const body = TicketLocalEditRequestSchema.parse({
        orderLabel: localEditDraft.orderLabel,
        channelLabel: localEditDraft.channelLabel,
        fulfillmentTimeLabel: localEditDraft.fulfillmentTimeLabel,
        note: localEditDraft.note
      });

      const response = await apiJson<RealtimeEvent>(`/api/kds/tickets/${localEditDraft.ticketId}/local-edit`, {
        method: "PUT",
        body: JSON.stringify(body)
      });
      applyRealtimeEvent(response);
      setLocalEditDraft(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to save local edit.");
    } finally {
      setLocalEditAction(null);
    }
  }

  async function resetLocalEditDraft() {
    if (!localEditDraft) {
      return;
    }

    setLocalEditAction("reset");
    setError(null);

    try {
      const response = await apiJson<RealtimeEvent>(`/api/kds/tickets/${localEditDraft.ticketId}/local-edit`, {
        method: "DELETE"
      });
      applyRealtimeEvent(response);
      setLocalEditDraft(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to reset local edit.");
    } finally {
      setLocalEditAction(null);
    }
  }

  async function saveSettings() {
    if (!merchantId) {
      return;
    }

    setSettingsSaving(true);
    setSettingsMessage(null);

    try {
      const next = await apiJson<BoardScreenSettings>(`/api/kds/settings?merchantId=${encodeURIComponent(merchantId)}`, {
        method: "PUT",
        body: JSON.stringify(settings)
      });
      const normalizedSettings = normalizeBoardSettings(
        {
          ...next,
          ...pickBoardVisualSettings(settings)
        },
        settings.boardTimeZone,
        pickBoardVisualSettings(settings)
      );

      startTransition(() => {
        setSettings(normalizedSettings);
        setBoardTimeZone(normalizedSettings.boardTimeZone);
        setSnapshot((current) => (current ? { ...current, filter: normalizedSettings.filter } : current));
        setSettingsMessage("Settings saved.");
      });
    } catch (cause) {
      setSettingsMessage(cause instanceof Error ? cause.message : "Failed to save settings.");
    } finally {
      setSettingsSaving(false);
    }
  }

  async function seedDemoTickets() {
    if (!merchantId) {
      return;
    }

    setDemoSeeding(true);
    setSettingsMessage(null);

    try {
      await apiJson<{ ok: true; count: number }>(`/api/kds/demo/orders?merchantId=${encodeURIComponent(merchantId)}`, {
        method: "POST"
      });
      await loadSnapshot();
      setSettingsMessage("Deliverect demo tickets added.");
    } catch (cause) {
      setSettingsMessage(cause instanceof Error ? cause.message : "Failed to add demo tickets.");
    } finally {
      setDemoSeeding(false);
    }
  }

  return (
    <main className="board-shell">
      <section className="fresh-board-shell">
        <div className="board-floating-notices" aria-live="polite" aria-atomic="true">
          {actionToast ? (
            <div className={`board-action-toast board-action-toast-${actionToast.tone}`} role="status">
              <span className="board-action-toast-dot" aria-hidden="true" />
              <span>{actionToast.message}</span>
            </div>
          ) : null}
        </div>
        {error ? <p className="toast-error">{error}</p> : null}
        {connectionState === "offline" ? (
          <p className="toast-warning">Realtime link dropped. The board will reconnect and backfill recent changes automatically.</p>
        ) : null}

        <section className="fresh-board-stage">
          <aside className="fresh-board-rail">
            <div className="fresh-rail-count">{boardStats.openCount}</div>
            <div className="fresh-rail-label">OPEN</div>
            <div className="fresh-rail-metric" aria-label={`Average time ${formatElapsed(boardStats.avgMinutes)}`}>
              {formatRailElapsedParts(boardStats.avgMinutes).map((part) => (
                <span className="fresh-rail-metric-line" key={part.unit}>
                  <span className="fresh-rail-metric-value">{part.value}</span>
                  <span className="fresh-rail-metric-unit">{part.unit}</span>
                </span>
              ))}
            </div>
            <div className="fresh-rail-label">AVG. TIME</div>
            <button className="fresh-rail-button" onClick={() => setDrawer((current) => current === "completed" ? null : "completed")}>
              RECALL
              <span>{completedTickets.length}</span>
            </button>
            <div className="fresh-board-controls fresh-board-controls-rail">
              <span className={`fresh-chip fresh-chip-${connectionState}`}>{connectionState}</span>
              <span className="fresh-chip">{currentClock}</span>
            </div>
            <div className="fresh-rail-spacer" aria-hidden="true" />
            <div className="fresh-rail-footer">
              <button
                className={`fresh-rail-settings-button${drawer === "settings" ? " is-active" : ""}`}
                aria-label="Open settings"
                title="Settings"
                onClick={() => setDrawer((current) => current === "settings" ? null : "settings")}
              >
                <SettingsIcon />
              </button>
            </div>
          </aside>

          <section className="fresh-board-canvas">
            {activeTickets.length === 0 ? (
              <div className="fresh-empty-state">
                <h2>No open tickets</h2>
                <p>Fresh KDS board is connected. New Clover and Deliverect orders will appear here automatically.</p>
              </div>
            ) : (
              <div className="fresh-ticket-grid">
                {activeTickets.map((ticket) => (
                  <TicketCard
                    key={ticket.id}
                    now={clockNow}
                    ticket={ticket}
                    variant="active"
                    pending={pendingActions[ticket.id]?.action}
                    isMutating={ticketMutation?.ticketId === ticket.id}
                    menuOpen={openTicketMenuId === ticket.id}
                    pendingItemIds={pendingItemKeysByTicket.get(ticket.id)}
                    orderTimeLabel={formatTicketTime(timeFormatter, ticket.createdAt)}
                    visualSettings={visualSettings}
                    onComplete={handleComplete}
                    onDelete={deleteTicketLocally}
                    onMenuClose={handleCloseTicketMenu}
                    onMenuToggle={handleToggleTicketMenu}
                    onEdit={handleOpenLocalEdit}
                    onToggleItem={handleToggleItem}
                  />
                ))}
              </div>
            )}
          </section>
        </section>

        {drawer ? <div className="board-drawer-backdrop" role="presentation" onClick={() => setDrawer(null)} /> : null}

        {drawer === "completed" ? (
          <aside className="history-drawer">
            <div className="history-header">
              <div>
                <p className="eyebrow">Recall</p>
                <h2>Completed tickets</h2>
              </div>
              <button className="ghost-button" onClick={() => setDrawer(null)}>
                Close
              </button>
            </div>
            <div className="history-list">
              {completedTickets.length === 0 ? <p className="lane-empty">No completed tickets yet.</p> : null}
              {completedTickets.map((ticket) => (
                <TicketCard
                  key={ticket.id}
                  now={clockNow}
                  ticket={ticket}
                  variant="completed"
                  pending={pendingActions[ticket.id]?.action}
                  orderTimeLabel={formatTicketTime(timeFormatter, ticket.createdAt)}
                  visualSettings={visualSettings}
                  onRecall={handleRecall}
                />
              ))}
            </div>
          </aside>
        ) : null}

        {drawer === "settings" ? (
          <aside className="settings-drawer">
            <div className="settings-close-wrap">
              <button className="ghost-button settings-close-button" onClick={() => setDrawer(null)}>
                Close
              </button>
            </div>
            <div className="settings-drawer-header">
              <div className="settings-drawer-title">
                <SettingsIcon />
                <div>
                  <p className="eyebrow">Settings</p>
                  <h2>Board setup</h2>
                </div>
              </div>
            </div>

            {settingsMessage ? <p className="toast-info settings-toast">{settingsMessage}</p> : null}

            <div className="settings-stack">
              {authSession ? (
                <SettingsAccessCard displayName={authSession.displayName} initialPasskeys={initialPasskeys} />
              ) : null}

              <section className="settings-card">
                <div className="settings-section-head">
                  <div>
                    <p className="eyebrow">Store</p>
                    <h3>Kitchen board</h3>
                  </div>
                  <span className="settings-merchant-id">{merchantId || "No merchant"}</span>
                </div>

                <label className="settings-field">
                  <span>Timezone</span>
                  <div
                    className="settings-readonly-value"
                    aria-readonly="true"
                    data-testid="settings-board-timezone"
                  >
                    {boardTimeZoneLabel}
                  </div>
                </label>
                <p className="settings-readonly-note">
                  Operator config is managed in the Backoffice. <ManageInBackofficeLink path="/admin/board" />
                </p>
              </section>

              <section className="settings-card">
                <div className="settings-section-head">
                  <div>
                    <p className="eyebrow">Customer display</p>
                    <h3>Weather</h3>
                  </div>
                </div>

                <label className="settings-field">
                  <span>Weather widget</span>
                  <div
                    className="settings-readonly-value"
                    aria-readonly="true"
                    data-testid="settings-weather-summary"
                  >
                    {weatherSummary}
                  </div>
                </label>
                <p className="settings-readonly-note">
                  Weather config is managed in the Backoffice. <ManageInBackofficeLink path="/admin/board" />
                </p>
              </section>

              <section className="settings-card">
                <div className="settings-section-head">
                  <div>
                    <p className="eyebrow">Reset</p>
                    <h3>Auto delete data</h3>
                  </div>
                </div>

                <label className="settings-field">
                  <span>Nightly auto delete</span>
                  <div
                    className="settings-readonly-value"
                    aria-readonly="true"
                    data-testid="settings-daily-reset-summary"
                  >
                    {dailyResetSummary}
                  </div>
                </label>
                <p className="settings-readonly-note">
                  Reset schedule is managed in the Backoffice. <ManageInBackofficeLink path="/admin/board" />
                </p>
              </section>

              <section className="settings-card">
                <div className="settings-section-head">
                  <div>
                    <p className="eyebrow">Board</p>
                    <h3>Alerts and pairing</h3>
                  </div>
                </div>

                <ToggleRow
                  label="Alerts on this screen"
                  note="Temporary mute for this board only. This does not change store-wide sound settings."
                  active={!muted}
                  onToggle={() => setMuted((value) => !value)}
                />

                <ToggleRow
                  label="New ticket sound"
                  note="Play the board alert tone when a new order lands."
                  active={settings.filter.soundEnabled}
                  onToggle={() =>
                    setSettings((current) => ({
                      ...current,
                      filter: {
                        ...current.filter,
                        soundEnabled: !current.filter.soundEnabled
                      }
                    }))
                  }
                />

                <ToggleRow
                  label="Require screen PIN"
                  note="Keep pairing locked down on kitchen screens."
                  active={settings.filter.screenPinEnabled}
                  onToggle={() =>
                    setSettings((current) => ({
                      ...current,
                      filter: {
                        ...current.filter,
                        screenPinEnabled: !current.filter.screenPinEnabled
                      }
                    }))
                  }
                />
              </section>

              <section className="settings-card">
                <div className="settings-section-head">
                  <div>
                    <p className="eyebrow">Cues</p>
                    <h3>Urgency and modifiers</h3>
                  </div>
                </div>

                <div className="settings-field-grid">
                  <label className="settings-field">
                    <span>Warning after minutes</span>
                    <div
                      className="settings-readonly-value tabular-nums"
                      aria-readonly="true"
                      data-testid="settings-urgency-warning"
                    >
                      {settings.urgencyWarningMinutes}
                    </div>
                  </label>

                  <label className="settings-field">
                    <span>Critical after minutes</span>
                    <div
                      className="settings-readonly-value tabular-nums"
                      aria-readonly="true"
                      data-testid="settings-urgency-critical"
                    >
                      {settings.urgencyCriticalMinutes}
                    </div>
                  </label>
                </div>

                <label className="settings-field">
                  <span>Blink critical timer</span>
                  <div
                    className="settings-readonly-value"
                    aria-readonly="true"
                    data-testid="settings-urgency-blink"
                  >
                    {settings.urgencyBlinkCritical ? "On" : "Off"}
                  </div>
                </label>

                <p className="settings-readonly-note">
                  Urgency thresholds are managed in the Backoffice. <ManageInBackofficeLink path="/admin/board" />
                </p>

                <label className="settings-field">
                  <span>Danger modifier keywords</span>
                  <input
                    value={settings.modifierDangerKeywords.join(", ")}
                    onChange={(event) =>
                      updateVisualSettings({
                        modifierDangerKeywords: splitCsv(event.target.value)
                      })
                    }
                    placeholder="no, allergy, gluten-free"
                  />
                </label>

                <label className="settings-field">
                  <span>Accent modifier keywords</span>
                  <input
                    value={settings.modifierAccentKeywords.join(", ")}
                    onChange={(event) =>
                      updateVisualSettings({
                        modifierAccentKeywords: splitCsv(event.target.value)
                      })
                    }
                    placeholder="extra, add, on side"
                  />
                </label>
              </section>

              <section className="settings-card">
                <div className="settings-section-head">
                  <div>
                    <p className="eyebrow">Filters</p>
                    <h3>Board scope</h3>
                  </div>
                </div>

                <div className="settings-field-grid">
                  <label className="settings-field">
                    <span>Search text</span>
                    <input
                      value={settings.filter.searchText}
                      onChange={(event) =>
                        setSettings((current) => ({
                          ...current,
                          filter: {
                            ...current.filter,
                            searchText: event.target.value
                          }
                        }))
                      }
                      placeholder="burger, pickup, order note..."
                    />
                  </label>

                  <label className="settings-field">
                    <span>Created within minutes</span>
                    <input
                      type="number"
                      min={0}
                      value={settings.filter.createdAfterMinutes ?? ""}
                      onChange={(event) =>
                        setSettings((current) => ({
                          ...current,
                          filter: {
                            ...current.filter,
                            createdAfterMinutes: event.target.value ? Number(event.target.value) : null
                          }
                        }))
                      }
                      placeholder="120"
                    />
                  </label>
                </div>

                <label className="settings-field">
                  <span>Allowed order types</span>
                  <input
                    value={settings.filter.allowedOrderTypes.join(", ")}
                    onChange={(event) =>
                      setSettings((current) => ({
                        ...current,
                        filter: {
                          ...current.filter,
                          allowedOrderTypes: splitCsv(event.target.value)
                        }
                      }))
                    }
                    placeholder="Pickup, Delivery"
                  />
                </label>

                <label className="settings-field">
                  <span>Blocked sources</span>
                  <input
                    value={settings.filter.blockedSources.join(", ")}
                    onChange={(event) =>
                      setSettings((current) => ({
                        ...current,
                        filter: {
                          ...current.filter,
                          blockedSources: splitCsv(event.target.value)
                        }
                      }))
                    }
                    placeholder="Sandbox register"
                  />
                </label>

                <label className="settings-field">
                  <span>Payment states</span>
                  <input
                    value={settings.filter.paymentStates.join(", ")}
                    onChange={(event) =>
                      setSettings((current) => ({
                        ...current,
                        filter: {
                          ...current.filter,
                          paymentStates: splitCsv(event.target.value)
                        }
                      }))
                    }
                    placeholder="PAID, OPEN"
                  />
                </label>
              </section>

              <section className="settings-card" data-testid="settings-deliverect-section">
                <div className="settings-section-head">
                  <div>
                    <p className="eyebrow">Aggregator</p>
                    <h3>Deliverect</h3>
                  </div>
                </div>

                <DeliverectStatusCard deliverect={settings.providers.deliverect} />

                <div className="settings-inline-actions">
                  <button className="ghost-button" disabled={demoSeeding} onClick={() => void seedDemoTickets()}>
                    {demoSeeding ? "Adding demo tickets..." : "Add Deliverect demo tickets"}
                  </button>
                </div>
              </section>
            </div>

            <div className="settings-drawer-actions">
              <button className="ghost-button" onClick={() => void loadSettings()}>
                Reset
              </button>
              <button className="primary-button" disabled={settingsSaving} onClick={() => void saveSettings()}>
                {settingsSaving ? "Saving..." : "Save Settings"}
              </button>
            </div>
          </aside>
        ) : null}

        {localEditDraft ? (
          <div className="ticket-edit-backdrop" role="presentation" onClick={() => localEditAction ? null : setLocalEditDraft(null)}>
            <section
              className="ticket-edit-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="ticket-edit-title"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="ticket-edit-header">
                <div>
                  <p className="eyebrow">Order actions</p>
                  <h2 id="ticket-edit-title">Edit order</h2>
                </div>
                <button className="ghost-button" disabled={Boolean(localEditAction)} onClick={() => setLocalEditDraft(null)}>
                  Close
                </button>
              </div>

              <div className="ticket-edit-grid">
                <label className="settings-field">
                  <span>Order title</span>
                  <input
                    value={localEditDraft.orderLabel}
                    disabled={Boolean(localEditAction)}
                    onChange={(event) =>
                      setLocalEditDraft((current) => current ? { ...current, orderLabel: event.target.value } : current)
                    }
                    placeholder="Jordan"
                  />
                </label>

                <label className="settings-field">
                  <span>Channel label</span>
                  <input
                    value={localEditDraft.channelLabel}
                    disabled={Boolean(localEditAction)}
                    onChange={(event) =>
                      setLocalEditDraft((current) => current ? { ...current, channelLabel: event.target.value } : current)
                    }
                    placeholder="Pickup"
                  />
                </label>

                <label className="settings-field">
                  <span>Fulfillment time</span>
                  <input
                    value={localEditDraft.fulfillmentTimeLabel}
                    disabled={Boolean(localEditAction)}
                    onChange={(event) =>
                      setLocalEditDraft((current) => current ? { ...current, fulfillmentTimeLabel: event.target.value } : current)
                    }
                    placeholder="12:15 PM"
                  />
                </label>

                <label className="settings-field ticket-edit-note-field">
                  <span>Order note</span>
                  <textarea
                    value={localEditDraft.note}
                    disabled={Boolean(localEditAction)}
                    onChange={(event) =>
                      setLocalEditDraft((current) => current ? { ...current, note: event.target.value } : current)
                    }
                    placeholder="Add a local note for the kitchen..."
                  />
                </label>
              </div>

              <div className="ticket-edit-actions">
                {localEditDraft.hasLocalEdits ? (
                  <button className="ghost-button" disabled={Boolean(localEditAction)} onClick={() => void resetLocalEditDraft()}>
                    {localEditAction === "reset" ? "Resetting..." : "Reset to Clover"}
                  </button>
                ) : (
                  <span className="ticket-edit-spacer" aria-hidden="true" />
                )}
                <button className="ghost-button" disabled={Boolean(localEditAction)} onClick={() => setLocalEditDraft(null)}>
                  Cancel
                </button>
                <button
                  className="primary-button"
                  disabled={Boolean(localEditAction) || localEditDraft.orderLabel.trim().length === 0}
                  onClick={() => void saveLocalEditDraft()}
                >
                  {localEditAction === "save" ? "Saving..." : "Save"}
                </button>
              </div>
            </section>
          </div>
        ) : null}
      </section>
    </main>
  );
}

type TicketCardVariant = "active" | "completed";

type TicketCardProps = {
  ticket: KdsTicket;
  now: number;
  orderTimeLabel: string;
  variant: TicketCardVariant;
  visualSettings: BoardVisualSettings;
  isMutating?: boolean | undefined;
  menuOpen?: boolean | undefined;
  pending?: BoardAction | undefined;
  pendingItemIds?: ReadonlySet<string> | undefined;
  onComplete?: ((ticketId: string) => void) | undefined;
  onDelete?: ((ticket: KdsTicket) => void) | undefined;
  onRecall?: ((ticketId: string) => void) | undefined;
  onMenuClose?: (() => void) | undefined;
  onMenuToggle?: ((ticketId: string) => void) | undefined;
  onToggleItem?: ((ticketId: string, itemKey: string) => void) | undefined;
  onEdit?: ((ticket: KdsTicket) => void) | undefined;
};

const TicketCard = memo(function TicketCard({
  ticket,
  now,
  orderTimeLabel,
  variant,
  visualSettings,
  isMutating,
  menuOpen,
  pending,
  pendingItemIds,
  onComplete,
  onDelete,
  onRecall,
  onMenuClose,
  onMenuToggle,
  onToggleItem,
  onEdit
}: TicketCardProps) {
  const serviceTone = toneForOrderChannel(ticket);
  const elapsedLabel = formatElapsedPrecise(getTicketElapsedSeconds(ticket, now));
  const channelLabel = describeOrderChannel(ticket);
  const channelIcon = iconForOrderChannel(channelLabel);
  const urgencyTier = variant === "active" ? getTicketUrgencyTier(ticket, now, visualSettings) : "normal";
  const completedItems = countCompletedItems(ticket);
  const className = [
    "ticket-card",
    "fresh-ticket",
    `ticket-state-${ticket.status}`,
    variant === "active" ? `urgency-${urgencyTier}` : null,
    variant === "active" && urgencyTier === "critical" && !visualSettings.urgencyBlinkCritical ? "urgency-blink-disabled" : null,
    menuOpen ? "is-menu-open" : null,
    pending ? "is-pending" : null
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <article className={className}>
      <header className="ticket-head">
        <div className="ticket-head-row">
          <div className="ticket-title">
            <h3>{ticket.orderLabel}</h3>
          </div>
          {variant === "active" && onComplete ? (
            <button
              type="button"
              className="ticket-close-button"
              aria-label={`Complete ${ticket.orderLabel}`}
              aria-busy={pending === "complete"}
              disabled={Boolean(pending)}
              onClick={() => onComplete(ticket.id)}
            >
              <span aria-hidden="true">×</span>
            </button>
          ) : null}
        </div>

        <div className="ticket-head-footer">
          <p className="ticket-label">{orderTimeLabel}</p>
          <div className="ticket-meta">
            <span className="ticket-timer">{elapsedLabel}</span>
          </div>
        </div>
      </header>

      {variant === "active" ? (
        <div className="ticket-service-row">
          <span className={`service-chip ticket-channel service-${serviceTone}`}>
            <ChannelIcon kind={channelIcon} />
            <span>{channelLabel}</span>
          </span>
          {completedItems > 0 ? (
            <span className="ticket-progress-chip" aria-label={`${completedItems} of ${ticket.items.length} items completed`}>
              {completedItems}/{ticket.items.length}
            </span>
          ) : null}
          <div
            className={`ticket-overflow-wrap${menuOpen ? " is-open" : ""}`}
            data-ticket-menu-root
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                onMenuClose?.();
              }
            }}
          >
            <button
              type="button"
              className="ticket-overflow"
              aria-label={`More actions for ${ticket.orderLabel}`}
              aria-expanded={menuOpen}
              disabled={Boolean(pending) || isMutating || (!onEdit && !onDelete)}
              onClick={() => onMenuToggle?.(ticket.id)}
            >
              ...
            </button>
            {menuOpen ? (
              <div className="ticket-overflow-menu" role="menu" aria-label={`Actions for ${ticket.orderLabel}`}>
                <button
                  type="button"
                  className="ticket-overflow-menu-item"
                  role="menuitem"
                  disabled={isMutating || !onEdit}
                  onClick={() => onEdit?.(ticket)}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="ticket-overflow-menu-item ticket-overflow-menu-item-danger"
                  role="menuitem"
                  disabled={isMutating || !onDelete}
                  onClick={() => onDelete?.(ticket)}
                >
                  {isMutating ? "Deleting..." : "Delete"}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {ticket.note ? <p className="ticket-note">{ticket.note}</p> : null}

      <ul className="ticket-items">
        {ticket.items.map((item) => {
          const itemCompleted = isBoardItemComplete(item);
          const itemPending = pendingItemIds?.has(item.itemKey) ?? false;
          const itemDisplayName = displayNameForBoardItem(item);
          const itemDetails = displayDetailsForBoardItem(item);
          const itemClassName = [
            "item-row",
            variant === "active" && onToggleItem ? "item-row-button" : "item-row-static",
            itemCompleted ? "is-complete" : null,
            itemPending ? "is-item-pending" : null
          ]
            .filter(Boolean)
            .join(" ");
          const itemBody = (
            <>
              <strong className="qty-chip">{item.quantity}</strong>
              <div className="item-copy">
                <span className="item-name">{itemDisplayName}</span>
                {itemDetails.length > 0 ? (
                  <div className="item-modifier-list">
                    {itemDetails.map((detail, index) => (
                      <span
                        key={`${item.id}-detail-${index}`}
                        className={`item-modifier-pill item-modifier-${toneForModifier(detail, visualSettings)}`}
                      >
                        {detail}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
              <span className={`item-toggle-indicator${itemCompleted ? " is-complete" : ""}`} aria-hidden="true">
                {itemPending ? "..." : itemCompleted ? "✓" : ""}
              </span>
            </>
          );

          return (
            <li key={item.id}>
              {variant === "active" && onToggleItem ? (
                <button
                  type="button"
                  className={itemClassName}
                  aria-pressed={itemCompleted}
                  aria-busy={itemPending}
                  aria-label={`${itemCompleted ? "Mark incomplete" : "Mark complete"} ${itemDisplayName}`}
                  disabled={Boolean(pending) || itemPending}
                  onClick={() => onToggleItem(ticket.id, item.itemKey)}
                >
                  {itemBody}
                </button>
              ) : (
                <div className={itemClassName}>{itemBody}</div>
              )}
            </li>
          );
        })}
      </ul>

      {variant === "completed" && onRecall ? (
        <footer className="ticket-actions fresh-ticket-actions">
          <button
            type="button"
            className="ticket-recall-button"
            aria-busy={pending === "recall"}
            disabled={Boolean(pending)}
            onClick={() => onRecall(ticket.id)}
          >
            {pending === "recall" ? "Recalling..." : "Recall"}
          </button>
        </footer>
      ) : null}
    </article>
  );
});

function ToggleRow({
  label,
  note,
  active,
  onToggle
}: {
  label: string;
  note: string;
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="settings-toggle-row">
      <div>
        <p className="settings-toggle-label">{label}</p>
        <p className="settings-toggle-note">{note}</p>
      </div>
      <button type="button" className={`settings-toggle${active ? " is-active" : ""}`} onClick={onToggle}>
        {active ? "On" : "Off"}
      </button>
    </div>
  );
}

function splitCsv(input: string) {
  return input
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}
