"use client";

import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import type { CustomerDisplayWeatherSettings, KdsTicket } from "@rop/contracts";
import { apiJson, getWsBaseUrl } from "@/lib/api";
import { createRealtimeCoalescer } from "@/lib/realtime-coalescer";
import {
  announcementFromEvent,
  completedItemAnnouncementKeys,
  isReadyForPickup,
  mergeDisplayTicket,
  pickCustomerVisibleTickets,
  pickupWindowExpired,
  releaseStaleAnnouncementKeys,
  splitPreparingVsReady,
  type CustomerAnnouncement
} from "@/lib/customer-display";
import { CustomerDisplayHeader } from "./customer-display/customer-display-header";
import { CustomerDisplayPreparingColumn } from "./customer-display/customer-display-preparing-column";
import { CustomerDisplayReadyColumn } from "./customer-display/customer-display-ready-column";
import { CustomerDisplayNowAnnouncing } from "./customer-display/customer-display-now-announcing";

type DisplayTicket = Pick<KdsTicket, "id" | "merchantId" | "orderLabel" | "status" | "createdAt" | "updatedAt"> & {
  sourceOrderId: string;
  items: Array<Pick<KdsTicket["items"][number], "itemKey" | "name" | "alternateName" | "refunded" | "quantity" | "completed">>;
};

type DisplaySnapshot = {
  merchantId: string;
  serverTime: string;
  serverSeq?: number;
  display?: {
    weather?: CustomerDisplayWeatherSettings;
  };
  tickets: DisplayTicket[];
};

type DisplayRealtimeEvent = {
  id?: string;
  type: string;
  merchantId: string;
  occurredAt: string;
  seq?: number;
  publishedAt?: string;
  ticket: DisplayTicket;
};
type DisplaySnapshotRequiredEvent = {
  id?: string;
  type: "snapshot.required";
  merchantId: string;
  occurredAt: string;
  seq?: number;
  publishedAt?: string;
  reason: string;
};
type DisplayRealtimeMessage = DisplayRealtimeEvent | DisplaySnapshotRequiredEvent;
type DisplayBackfillResponse = {
  merchantId: string;
  fromSeq: number;
  toSeq: number;
  events: DisplayRealtimeMessage[];
  snapshotRequired: boolean;
};

function isDisplaySnapshotRequiredEvent(
  event: DisplayRealtimeMessage
): event is DisplaySnapshotRequiredEvent {
  return event.type === "snapshot.required";
}

type AudioEngine = {
  context: AudioContext;
  keepAlive: OscillatorNode;
  keepAliveGain: GainNode;
};

type SoundStatus = "checking" | "ready" | "blocked" | "unsupported";

const VISIBLE_TICKET_LIMIT = 16;
// The 16:9 canvas is tuned to fit four preparing cards and up to six ready
// tiles without clipping — cap each column so a busy rush never overflows.
const PREPARING_DISPLAY_LIMIT = 4;
const READY_DISPLAY_LIMIT = 6;
const FRESH_READY_TIMEOUT_MS = 2400;
// How often the display re-evaluates pickup expiry: drops orders that have been
// "ready for pickup" longer than PICKUP_DISPLAY_WINDOW_MS even with no new event.
const PICKUP_EXPIRY_TICK_MS = 20_000;
const SPEECH_FALLBACK_TIMEOUT_MS = 12_000;
const AUDIO_HEALTHCHECK_MS = 15_000;
const SNAPSHOT_REFRESH_MIN_INTERVAL_MS = 1_500;
const DEFAULT_WEATHER_CONFIG: CustomerDisplayWeatherSettings = {
  enabled: true,
  zipCode: "00000",
  countryCode: "US",
  unit: "fahrenheit"
};
let activeSpeechUtterance: SpeechSynthesisUtterance | null = null;

function buildTicketsQuery(merchantId: string) {
  const query = new URLSearchParams();

  if (merchantId) {
    query.set("merchantId", merchantId);
  }

  return query.toString();
}

function buildSocketPath(merchantId: string) {
  return merchantId ? `/ws/display?merchantId=${encodeURIComponent(merchantId)}` : "/ws/display";
}

function pickSpeechVoice(voices: SpeechSynthesisVoice[]) {
  const englishVoices = voices.filter((voice) => voice.lang.toLowerCase().startsWith("en"));
  const preferred = englishVoices.find((voice) =>
    voice.localService &&
    /samantha|victoria|natural|premium|enhanced|aria|jenny|google us english/i.test(voice.name)
  );

  return preferred ?? englishVoices.find((voice) => voice.localService) ?? englishVoices[0] ?? null;
}

function getAudioContextConstructor() {
  if (typeof window === "undefined") {
    return null;
  }

  return window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ?? null;
}

function createPersistentAudioEngine(): AudioEngine | null {
  const AudioContextCtor = getAudioContextConstructor();
  if (!AudioContextCtor) {
    return null;
  }

  const context = new AudioContextCtor();
  const keepAlive = context.createOscillator();
  const keepAliveGain = context.createGain();
  keepAlive.type = "sine";
  keepAlive.frequency.value = 20;
  keepAliveGain.gain.value = 0.00001;
  keepAlive.connect(keepAliveGain);
  keepAliveGain.connect(context.destination);
  keepAlive.start();

  return {
    context,
    keepAlive,
    keepAliveGain
  };
}

function stopAudioEngine(engine: AudioEngine | null) {
  if (!engine) {
    return;
  }

  try {
    engine.keepAlive.stop();
  } catch {
    // The oscillator may already be stopped during React cleanup.
  }
  void engine.context.close();
}

async function resumeAudioEngine(engine: AudioEngine) {
  if (engine.context.state === "suspended") {
    await engine.context.resume();
  }

  return engine.context.state === "running";
}

function playChime(context: AudioContext) {
  const now = context.currentTime;
  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.22, now + 0.03);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.52);
  gain.connect(context.destination);

  for (const [index, frequency] of [659, 880].entries()) {
    const oscillator = context.createOscillator();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency, now + index * 0.13);
    oscillator.connect(gain);
    oscillator.start(now + index * 0.13);
    oscillator.stop(now + 0.45 + index * 0.08);
  }
}

function wait(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function speakAnnouncement(text: string) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    return Promise.resolve(false);
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (spoken: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timeout);
      if (activeSpeechUtterance === utterance) {
        activeSpeechUtterance = null;
      }
      resolve(spoken);
    };

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    const timeout = window.setTimeout(() => finish(false), SPEECH_FALLBACK_TIMEOUT_MS);
    activeSpeechUtterance = utterance;
    const voice = pickSpeechVoice(window.speechSynthesis.getVoices());
    if (voice) {
      utterance.voice = voice;
    }
    utterance.lang = voice?.lang ?? "en-US";
    utterance.rate = 0.92;
    utterance.pitch = 1.02;
    utterance.volume = 1;
    utterance.onend = () => finish(true);
    utterance.onerror = () => finish(false);
    window.speechSynthesis.resume();
    window.speechSynthesis.speak(utterance);
  });
}

export function CustomerDisplayScreen({
  initialMerchantId
}: {
  initialMerchantId: string;
}) {
  const [merchantId, setMerchantId] = useState(initialMerchantId);
  const [tickets, setTickets] = useState<DisplayTicket[]>([]);
  const [weatherConfig, setWeatherConfig] = useState<CustomerDisplayWeatherSettings | null>(DEFAULT_WEATHER_CONFIG);
  const [error, setError] = useState<string | null>(null);
  const [activeAnnouncement, setActiveAnnouncement] = useState<CustomerAnnouncement | null>(null);
  const [justBecameReady, setJustBecameReady] = useState<Set<string>>(() => new Set());
  const [soundStatus, setSoundStatus] = useState<SoundStatus>("checking");
  const audioEngine = useRef<AudioEngine | null>(null);
  const announcementQueue = useRef<CustomerAnnouncement[]>([]);
  const isDrainingAnnouncementQueue = useRef(false);
  const announcedItemKeys = useRef<Set<string>>(new Set());
  const snapshotAnnouncementHydrated = useRef(false);
  const reconnectTimer = useRef<number | null>(null);
  const lastRealtimeSeq = useRef(0);
  const realtimeBackfillInFlight = useRef(false);
  const deferredRealtimeEvents = useRef<DisplayRealtimeMessage[]>([]);
  const snapshotInFlight = useRef<Promise<void> | null>(null);
  const deferredSnapshotTimer = useRef<number | null>(null);
  const lastSnapshotStartedAt = useRef(0);
  const realtimeCoalescer = useRef<ReturnType<typeof createRealtimeCoalescer<DisplayRealtimeEvent>> | null>(null);
  // ticketId -> client-clock ms when this display first saw the order become
  // ready for pickup. Drives the fresh-promote (first transition) and the
  // pickup-window expiry; an entry present means "currently ready on screen".
  const readySinceRef = useRef<Map<string, number>>(new Map());
  const freshTimeoutsRef = useRef<Map<string, number>>(new Map());
  const canvasRef = useRef<HTMLDivElement | null>(null);

  const visibleTickets = useMemo(
    () => pickCustomerVisibleTickets(tickets, VISIBLE_TICKET_LIMIT),
    [tickets]
  );
  const { preparing, ready } = useMemo(
    () => splitPreparingVsReady(visibleTickets),
    [visibleTickets]
  );

  const ensureAudio = useEffectEvent(async () => {
    let engine = audioEngine.current;
    if (!engine) {
      engine = createPersistentAudioEngine();
      audioEngine.current = engine;
    }

    if (!engine) {
      setSoundStatus("unsupported");
      return false;
    }

    try {
      const ready = await resumeAudioEngine(engine);
      setSoundStatus(ready ? "ready" : "blocked");
      return ready;
    } catch {
      setSoundStatus("blocked");
      return false;
    }
  });

  const playAnnouncement = useEffectEvent(async (announcement: CustomerAnnouncement) => {
    setActiveAnnouncement(announcement);

    const audioReady = await ensureAudio();
    if (!audioReady || !audioEngine.current) {
      const spoken = await speakAnnouncement(announcement.spokenText);
      if (!spoken) {
        setSoundStatus("blocked");
      }
      return;
    }

    playChime(audioEngine.current.context);
    await wait(360);
    const spoken = await speakAnnouncement(announcement.spokenText);
    if (!spoken) {
      setSoundStatus("blocked");
    }
  });

  const drainAnnouncementQueue = useEffectEvent(async () => {
    if (isDrainingAnnouncementQueue.current) {
      return;
    }

    isDrainingAnnouncementQueue.current = true;
    try {
      while (announcementQueue.current.length > 0) {
        const nextAnnouncement = announcementQueue.current.shift();
        if (nextAnnouncement) {
          await playAnnouncement(nextAnnouncement);
          await wait(500);
        }
      }
    } finally {
      isDrainingAnnouncementQueue.current = false;
    }
  });

  const announce = useEffectEvent((announcement: CustomerAnnouncement) => {
    announcementQueue.current.push(announcement);
    void drainAnnouncementQueue();
  });

  const scheduleFreshReady = useEffectEvent((ticketId: string) => {
    setJustBecameReady((prev) => {
      if (prev.has(ticketId)) {
        return prev;
      }
      const next = new Set(prev);
      next.add(ticketId);
      return next;
    });

    const existing = freshTimeoutsRef.current.get(ticketId);
    if (existing !== undefined) {
      window.clearTimeout(existing);
    }

    const timer = window.setTimeout(() => {
      setJustBecameReady((prev) => {
        if (!prev.has(ticketId)) {
          return prev;
        }
        const next = new Set(prev);
        next.delete(ticketId);
        return next;
      });
      freshTimeoutsRef.current.delete(ticketId);
    }, FRESH_READY_TIMEOUT_MS);

    freshTimeoutsRef.current.set(ticketId, timer);
  });

  const loadSnapshot = useEffectEvent(async () => {
    try {
      const snapshot = await apiJson<DisplaySnapshot>(`/api/display/tickets?${buildTicketsQuery(merchantId)}`);
      setMerchantId(snapshot.merchantId);
      setTickets(snapshot.tickets);
      if (typeof snapshot.serverSeq === "number") {
        lastRealtimeSeq.current = snapshot.serverSeq;
      }
      setWeatherConfig(snapshot.display?.weather ?? DEFAULT_WEATHER_CONFIG);
      setError(null);

      const shouldHydrateAnnouncementKeys = !snapshotAnnouncementHydrated.current;

      for (const ticket of snapshot.tickets) {
        const wasReady = readySinceRef.current.has(ticket.id);
        const nowReady = isReadyForPickup(ticket);

        if (shouldHydrateAnnouncementKeys) {
          for (const itemKey of completedItemAnnouncementKeys(ticket)) {
            announcedItemKeys.current.add(itemKey);
          }
        } else {
          releaseStaleAnnouncementKeys(ticket, announcedItemKeys.current);
          if (!wasReady && nowReady) {
            scheduleFreshReady(ticket.id);
          }
        }

        // Stamp when this display first saw the order ready so the pickup window
        // runs off time-on-screen, not the (possibly stale on a snapshot) server
        // updatedAt. Completed orders stay on screen until that window elapses.
        if (nowReady && !wasReady) {
          readySinceRef.current.set(ticket.id, Date.now());
        } else if (!nowReady) {
          readySinceRef.current.delete(ticket.id);
        }
      }

      snapshotAnnouncementHydrated.current = true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load the pickup display.");
    }
  });

  const requestSnapshot = useEffectEvent(async (options?: { force?: boolean }) => {
    if (snapshotInFlight.current) {
      return snapshotInFlight.current;
    }

    const now = Date.now();
    const elapsed = now - lastSnapshotStartedAt.current;
    if (!options?.force && elapsed < SNAPSHOT_REFRESH_MIN_INTERVAL_MS) {
      if (deferredSnapshotTimer.current === null) {
        deferredSnapshotTimer.current = window.setTimeout(() => {
          deferredSnapshotTimer.current = null;
          void requestSnapshot({ force: true });
        }, SNAPSHOT_REFRESH_MIN_INTERVAL_MS - elapsed);
      }
      return;
    }

    if (deferredSnapshotTimer.current !== null) {
      window.clearTimeout(deferredSnapshotTimer.current);
      deferredSnapshotTimer.current = null;
    }

    lastSnapshotStartedAt.current = now;
    const snapshotPromise = loadSnapshot().finally(() => {
      if (snapshotInFlight.current === snapshotPromise) {
        snapshotInFlight.current = null;
      }
    });
    snapshotInFlight.current = snapshotPromise;
    return snapshotPromise;
  });

  const applyRealtimeBatch = useEffectEvent((events: DisplayRealtimeEvent[]) => {
    setTickets((current) =>
      events.reduce((next, event) => mergeDisplayTicket(next, event.ticket), current)
    );
    const last = events[events.length - 1];
    if (last) {
      setMerchantId(last.merchantId);
      setError(null);
    }
  });

  const applyRealtimeSideEffects = useEffectEvent((event: DisplayRealtimeEvent) => {
    const ticketId = event.ticket.id;
    const wasReady = readySinceRef.current.has(ticketId);
    const nowReady = isReadyForPickup(event.ticket);

    releaseStaleAnnouncementKeys(event.ticket, announcedItemKeys.current);

    if (!wasReady && nowReady) {
      scheduleFreshReady(ticketId);
    }

    if (nowReady && !wasReady) {
      readySinceRef.current.set(ticketId, Date.now());
    } else if (!nowReady) {
      readySinceRef.current.delete(ticketId);
    }

    const announcement = announcementFromEvent(event, announcedItemKeys.current);
    if (!announcement) {
      return;
    }

    for (const itemKey of announcement.itemKeys) {
      announcedItemKeys.current.add(itemKey);
    }
    void announce(announcement);
  });

  const applyRealtimeEvent = useEffectEvent((event: DisplayRealtimeMessage) => {
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

    if (isDisplaySnapshotRequiredEvent(event)) {
      realtimeCoalescer.current?.cancel();
      void requestSnapshot();
      return;
    }

    applyRealtimeSideEffects(event);
    const coalescer = realtimeCoalescer.current;
    if (coalescer) {
      coalescer.push(event);
    } else {
      applyRealtimeBatch([event]);
    }
  });

  const backfillRealtimeEvents = useEffectEvent(async (afterSeq: number) => {
    if (realtimeBackfillInFlight.current) {
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
        const response = await apiJson<DisplayBackfillResponse>(`/api/kds/events?${query.toString()}`);
        if (response.snapshotRequired) {
          realtimeCoalescer.current?.cancel();
          await requestSnapshot();
          return;
        }

        if (response.events.length === 0) {
          if (response.toSeq > cursor) {
            realtimeCoalescer.current?.cancel();
            await requestSnapshot();
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
      await requestSnapshot();
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
  }, []);

  useEffect(() => {
    void requestSnapshot({ force: true });
  }, []);

  useEffect(() => {
    if (!activeAnnouncement) {
      return;
    }

    const timer = window.setTimeout(() => {
      setActiveAnnouncement(null);
    }, 12_000);

    return () => {
      window.clearTimeout(timer);
    };
  }, [activeAnnouncement]);

  useEffect(() => {
    let cancelled = false;
    void ensureAudio().then(() => {
      if (cancelled) {
        return;
      }
    });

    return () => {
      cancelled = true;
    };
  }, [ensureAudio]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void ensureAudio();
    }, AUDIO_HEALTHCHECK_MS);

    return () => {
      window.clearInterval(timer);
    };
  }, [ensureAudio]);

  useEffect(() => {
    const loadVoices = () => {
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.getVoices();
      }
    };

    loadVoices();
    window.speechSynthesis?.addEventListener?.("voiceschanged", loadVoices);
    return () => {
      window.speechSynthesis?.removeEventListener?.("voiceschanged", loadVoices);
    };
  }, []);

  useEffect(() => {
    let closed = false;
    let socket: WebSocket | null = null;

    const connect = () => {
      socket = new WebSocket(`${getWsBaseUrl()}${buildSocketPath(merchantId)}`);

      socket.addEventListener("message", (message) => {
        if (typeof message.data !== "string" || message.data === "pong") {
          return;
        }

        try {
          applyRealtimeEvent(JSON.parse(message.data) as DisplayRealtimeMessage);
        } catch {
          setError("Received an invalid realtime update.");
        }
      });

      socket.addEventListener("close", () => {
        if (closed) {
          return;
        }

        reconnectTimer.current = window.setTimeout(() => {
          if (lastRealtimeSeq.current > 0) {
            void backfillRealtimeEvents(lastRealtimeSeq.current);
          } else {
            void requestSnapshot();
          }
          connect();
        }, 2_000);
      });
    };

    connect();

    return () => {
      closed = true;
      socket?.close();
      if (reconnectTimer.current) {
        window.clearTimeout(reconnectTimer.current);
      }
    };
  }, [merchantId]);

  useEffect(() => {
    return () => {
      announcementQueue.current = [];
      isDrainingAnnouncementQueue.current = false;
      activeSpeechUtterance = null;
      window.speechSynthesis?.cancel();
      if (deferredSnapshotTimer.current !== null) {
        window.clearTimeout(deferredSnapshotTimer.current);
      }
      stopAudioEngine(audioEngine.current);
      audioEngine.current = null;
    };
  }, []);

  useEffect(() => {
    const timers = freshTimeoutsRef.current;
    return () => {
      for (const timer of timers.values()) {
        window.clearTimeout(timer);
      }
      timers.clear();
    };
  }, []);

  // Auto-clear picked-up orders: drop ready/completed tickets that have been on
  // screen past the pickup window, even when no realtime event arrives. Expiry is
  // measured from when this display first saw each order ready (readySinceRef),
  // not the server timestamp. Preparing orders (no readySince entry) never expire.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const current = Date.now();
      setTickets((currentTickets) => {
        const kept = currentTickets.filter((ticket) => {
          const readySince = readySinceRef.current.get(ticket.id);
          return readySince === undefined || !pickupWindowExpired(readySince, current);
        });
        return kept.length === currentTickets.length ? currentTickets : kept;
      });
    }, PICKUP_EXPIRY_TICK_MS);

    return () => {
      window.clearInterval(timer);
    };
  }, []);

  // Keep readySinceRef bounded to tickets still on screen so expired/removed
  // orders don't leak entries on a long-lived display.
  useEffect(() => {
    const liveIds = new Set(tickets.map((ticket) => ticket.id));
    for (const id of readySinceRef.current.keys()) {
      if (!liveIds.has(id)) {
        readySinceRef.current.delete(id);
      }
    }
  }, [tickets]);

  // Letterbox a fixed 1920×1080 stage and scale it uniformly to the viewport so
  // the 16:9 layout never reflows or clips text on any wall TV or counter screen.
  // Centering (translate(-50%, -50%)) is owned by CSS so the stage stays centered
  // even before this effect runs or after a remount; here we only update the
  // --cd-scale factor. Never write a full `transform` here — a frame without the
  // translate flings the stage into the bottom-right corner.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const fit = () => {
      const scale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
      canvas.style.setProperty("--cd-scale", String(scale));
      // Reveal only once the correct scale is applied. The canvas starts
      // opacity:0 (see globals.css) so a reload/remount never flashes the
      // 1920×1080 stage at its default scale(1) for the frame before this runs
      // — which read as a sudden "zoom" on every signage refresh.
      canvas.classList.add("is-fitted");
    };

    fit();
    window.addEventListener("resize", fit);
    return () => {
      window.removeEventListener("resize", fit);
    };
  }, []);

  return (
    <div className="customer-display-stage">
      <div className="customer-display-canvas" ref={canvasRef}>
        <main className="customer-display-shell">
          <CustomerDisplayHeader weatherConfig={weatherConfig} />
          <div className="customer-display-main">
            <CustomerDisplayPreparingColumn
              tickets={preparing.slice(0, PREPARING_DISPLAY_LIMIT)}
            />
            <CustomerDisplayReadyColumn
              tickets={ready.slice(0, READY_DISPLAY_LIMIT)}
              freshIds={justBecameReady}
              announcingId={activeAnnouncement?.id ?? null}
            />
          </div>
          <CustomerDisplayNowAnnouncing announcement={activeAnnouncement} />
          {error ? <div className="customer-display-error" role="alert">{error}</div> : null}
          {soundStatus === "blocked" || soundStatus === "unsupported" ? (
            <div className="customer-display-sound-status" role="status" aria-live="polite">
              {soundStatus === "unsupported"
                ? "Sound unavailable on this display."
                : "Sound blocked. Allow autoplay/audio in AbleSign."}
            </div>
          ) : null}
        </main>
      </div>
    </div>
  );
}
