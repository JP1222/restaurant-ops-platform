"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CrewHome } from "./home-screen";
import { CrewTopBar } from "./top-bar";
import { IPadFrame } from "./ipad-frame";
import { ItemsScreen } from "./items-screen";
import { PinLogin } from "./pin-login";
import { ReceiveFlow } from "./receive-flow";
import { RecountFlow } from "./recount-flow";
import { ScanBarcodeFlow } from "./scan-barcode-flow";
import { ScanFlow } from "./scan-flow";
import { WasteFlow } from "./waste-flow";
import {
  CREW_SESSION_EXPIRED_EVENT,
  fetchInventory,
  getMe,
  logout as apiLogout
} from "@/lib/api";
import { CrewDataProvider, type CrewData } from "@/lib/crew-data";
import { STRINGS } from "@/lib/strings";
import type { Employee, Lang, Screen } from "@/lib/types";
import { useOnline } from "@/lib/use-online";

export function CrewApp() {
  const [lang, setLang] = useState<Lang>("es");
  const [employee, setEmployee] = useState<Employee | null>(null);
  const [screen, setScreen] = useState<Screen>("home");
  // Items sub-navigation, lifted here so the top-bar back can do detail → list
  // (when set) before list → home (design handoff §4). null = list / not on Items.
  const [sel, setSel] = useState<string | null>(null);
  const [clock, setClock] = useState("11:42");
  const [idle, setIdle] = useState(60);
  const [data, setData] = useState<CrewData | null>(null);
  const [dataError, setDataError] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Real device connectivity (design handoff §7) — drives the top-bar chip, the
  // offline banner below it, and the reconnect toast.
  const online = useOnline();
  // App-level toast: a bottom-center pill, auto-dismissed. Used for the flow-undo
  // confirmation ("Change undone") and the reconnect notice ("Back online").
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A screen can veto the top-bar back chevron (the scan review with unsaved
  // edits shows its own confirm instead of silently discarding). The guard
  // returns true when it handled the tap.
  const backGuard = useRef<(() => boolean) | null>(null);

  const showToast = useCallback((msg: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = setTimeout(() => setToast(null), 1700);
  }, []);
  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  // Surface a "Back online" toast on the offline → online edge only (not on first
  // mount, and not on every online render). The ref tracks the prior value.
  const prevOnline = useRef(online);
  useEffect(() => {
    if (!prevOnline.current && online && employee) {
      showToast(STRINGS[lang].net_back_online);
    }
    prevOnline.current = online;
  }, [online, lang, employee, showToast]);

  const loadData = useCallback(async () => {
    setDataError(false);
    try {
      const inv = await fetchInventory();
      setData({
        items: inv.items,
        categories: inv.categories,
        pos: inv.pos,
        wasteReasons: inv.waste_reasons,
        wasteSettings: inv.waste_settings,
        aliases: inv.item_aliases
      });
    } catch {
      setDataError(true);
    }
  }, []);

  // Restore an existing crew session on mount — the httpOnly cookie survives a
  // refresh, so a mid-shift reload shouldn't kick the cook back to the keypad.
  useEffect(() => {
    let active = true;
    void (async () => {
      const me = await getMe();
      if (!active) return;
      if (me) {
        setEmployee(me);
        await loadData();
      }
      setRestoring(false);
    })();
    return () => {
      active = false;
    };
  }, [loadData]);

  useEffect(() => {
    const interval = setInterval(() => {
      const d = new Date();
      const h = d.getHours() % 12 || 12;
      const m = String(d.getMinutes()).padStart(2, "0");
      setClock(`${h}:${m}`);
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  // Keep the home badges (open POs, critical stock) fresh across a shift: the
  // dataset used to be fetched once at login, so another cook's receive or a
  // backoffice 86 never showed up until re-login (2026-06-12 audit P1). Poll
  // only while parked on home — the flow screens already refresh after their
  // own writes via onChanged, and refreshing mid-flow could yank state under
  // the cook. Polling (not WebSocket) is the handoff-sanctioned pattern here.
  // A failed poll is naturally silent: the render only surfaces dataError when
  // there is no data at all, so stale-but-usable data stays on screen.
  const hasData = data !== null;
  useEffect(() => {
    if (!employee || screen !== "home" || !hasData) return;
    const tick = () => {
      if (document.visibilityState === "visible") void loadData();
    };
    const interval = setInterval(tick, 60_000);
    // An iPad waking from sleep shouldn't wait out the rest of the interval.
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [employee, screen, hasData, loadData]);

  // Centralized session-expiry recovery: any authenticated write that 401s fires
  // CREW_SESSION_EXPIRED_EVENT (lib/api). The httpOnly cookie can lapse (12h TTL)
  // while the SPA still shows the cook signed in — so without this they'd just get
  // "couldn't save" forever. Bounce to PIN login with a notice; clear the stale
  // cookie best-effort so the next login starts clean.
  useEffect(() => {
    const onExpired = () => {
      void apiLogout();
      setEmployee(null);
      setData(null);
      setScreen("home");
      setSel(null);
      setIdle(60);
      setSessionExpired(true);
    };
    window.addEventListener(CREW_SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(CREW_SESSION_EXPIRED_EVENT, onExpired);
  }, []);

  // Auto-logout idle countdown when on home; reset on any pointer input. On
  // timeout, sign out and clear the cookie so the next person on this shared
  // device starts fresh. The state changes live inside the updater (not the
  // effect body) to avoid cascading-render lint.
  useEffect(() => {
    if (!employee || screen !== "home") return;
    const t = setInterval(() => {
      setIdle((s) => {
        if (s <= 1) {
          void apiLogout();
          setEmployee(null);
          setData(null);
          setScreen("home");
          setSel(null);
          return 60;
        }
        return s - 1;
      });
    }, 1000);
    const reset = () => setIdle(60);
    window.addEventListener("pointerdown", reset);
    return () => {
      clearInterval(t);
      window.removeEventListener("pointerdown", reset);
    };
  }, [employee, screen]);

  const goHome = () => {
    setScreen("home");
    setSel(null);
    setIdle(60);
  };
  const goScreen = (s: Screen) => {
    setSel(null);
    setScreen(s);
    setIdle(60);
  };
  // The single back control (top-bar chevron): in Items, detail → list; else home.
  const goBack = () => {
    if (backGuard.current?.()) return;
    if (screen === "items" && sel) {
      setSel(null);
    } else {
      goHome();
    }
  };
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await loadData();
    } finally {
      setRefreshing(false);
    }
  }, [loadData]);
  // Stable identity so the registering screen's effect doesn't churn on every
  // crew-app render (the clock ticks one in every 30s).
  const registerBackGuard = useCallback((g: (() => boolean) | null) => {
    backGuard.current = g;
  }, []);
  const logout = () => {
    void apiLogout();
    setEmployee(null);
    setData(null);
    setScreen("home");
    setSel(null);
    setIdle(60);
  };
  const signIn = (e: Employee) => {
    setEmployee(e);
    setScreen("home");
    setSel(null);
    setIdle(60);
    setSessionExpired(false);
    void loadData();
  };

  const renderScreen = () => {
    if (restoring) {
      return <LoadingScreen lang={lang} />;
    }
    if (!employee) {
      return (
        <PinLogin
          lang={lang}
          setLang={setLang}
          onSuccess={signIn}
          notice={sessionExpired ? STRINGS[lang].pin_session_expired : null}
        />
      );
    }

    return (
      <div className="h-full flex flex-col relative">
        <CrewTopBar
          employee={employee}
          lang={lang}
          setLang={setLang}
          onLogout={logout}
          onBack={screen !== "home" ? goBack : null}
          title={null}
          idleSec={screen === "home" ? idle : null}
          online={online}
        />
        {!online && <OfflineBanner lang={lang} />}
        <div className="flex-1 min-h-0">
          {!data ? (
            dataError ? (
              <DataError lang={lang} onRetry={loadData} />
            ) : (
              <LoadingScreen lang={lang} />
            )
          ) : (
            <CrewDataProvider value={data}>
              {/* key={screen} remounts on every navigation so the CSS entrance
                  (crew-screen-in) replays — a soft fade + settle in place of the
                  old hard cut, especially on the way back home. */}
              <div key={screen} className="h-full crew-screen-in">
                {screen === "home" && (
                  <CrewHome
                    employee={employee}
                    lang={lang}
                    onPick={goScreen}
                    onRefresh={refresh}
                    refreshing={refreshing}
                  />
                )}
                {screen === "scan" && (
                  <ScanFlow
                    lang={lang}
                    onDone={goHome}
                    onChanged={loadData}
                    registerBackGuard={registerBackGuard}
                  />
                )}
                {screen === "items" && (
                  <ItemsScreen lang={lang} sel={sel} setSel={setSel} onChanged={loadData} showToast={showToast} />
                )}
                {screen === "receive" && (
                  <ReceiveFlow lang={lang} onDone={goHome} onChanged={loadData} />
                )}
                {screen === "waste" && (
                  <WasteFlow lang={lang} onDone={goHome} onChanged={loadData} showToast={showToast} />
                )}
                {screen === "recount" && (
                  <RecountFlow lang={lang} onDone={goHome} onChanged={loadData} showToast={showToast} />
                )}
                {screen === "scan-barcode" && (
                  <ScanBarcodeFlow lang={lang} onDone={goHome} onChanged={loadData} />
                )}
              </div>
            </CrewDataProvider>
          )}
        </div>
        {toast && (
          <div
            className="absolute left-1/2 -translate-x-1/2 bottom-8 z-[80] rounded-xl px-5 py-3 text-[15px] font-medium text-white whitespace-nowrap crew-toast-up"
            style={{ background: "rgba(24,24,27,0.92)" }}
            role="status"
            aria-live="polite"
          >
            {toast}
          </div>
        )}
      </div>
    );
  };

  return <IPadFrame time={clock}>{renderScreen()}</IPadFrame>;
}

function LoadingScreen({ lang }: { lang: Lang }) {
  const T = STRINGS[lang];
  return (
    <div className="h-full flex items-center justify-center bg-zinc-50">
      <div className="text-zinc-400 text-lg animate-pulse">{T.loading}</div>
    </div>
  );
}

// Offline banner under the top bar (design handoff §7). Amber strip with a
// no-wifi glyph. The copy promises browsing, not auto-sync — a durable offline
// write-queue is deferred, so a write attempted offline still surfaces the
// existing "no connection — try again" error (see lib/use-online.ts).
function OfflineBanner({ lang }: { lang: Lang }) {
  return (
    <div
      className="shrink-0 flex items-center gap-2.5 px-5 py-2.5 text-sm font-medium border-b crew-fade-in"
      style={{ background: "#fffbeb", borderColor: "#fde68a", color: "#b45309" }}
      role="status"
      aria-live="polite"
    >
      <svg
        viewBox="0 0 24 24"
        className="size-[18px] flex-none"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M1 1l22 22M8.5 16.5a5 5 0 0 1 7 0M5 12.55a10.94 10.94 0 0 1 5.17-2.39M10.71 5.05A16 16 0 0 1 22.58 9M1.42 9a15.91 15.91 0 0 1 4.7-2.88M12 20h.01" />
      </svg>
      {STRINGS[lang].net_offline_banner}
    </div>
  );
}

function DataError({ lang, onRetry }: { lang: Lang; onRetry: () => void }) {
  const T = STRINGS[lang];
  return (
    <div className="h-full flex items-center justify-center bg-zinc-50">
      <div className="text-center px-6">
        <div className="text-5xl mb-4">⚠️</div>
        <div className="text-zinc-700 font-medium">{T.data_error}</div>
        <button
          onClick={onRetry}
          className="mt-6 h-12 px-8 rounded-2xl bg-zinc-900 text-white font-semibold active:scale-95 transition-transform"
        >
          {T.retry}
        </button>
      </div>
    </div>
  );
}
