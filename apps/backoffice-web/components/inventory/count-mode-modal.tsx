"use client";

import * as React from "react";
import {
  Box,
  Camera,
  CheckCircle,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  EyeOff,
  Package,
  Pencil,
  Snowflake,
  Wine,
  X
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle
} from "@/components/ui/dialog";
import { formatCents } from "@/lib/format";
import { cn } from "@/lib/utils";
import type {
  InventoryCategoryId,
  InventoryDataset,
  InventoryItem
} from "@rop/contracts";

import { useIsMobile } from "@/lib/inventory/use-is-mobile";

const STORAGE_KEY = "restaurant-ops-platform:count-session:v1";

interface AreaPreset {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  blurb: string;
  categories: InventoryCategoryId[];
}

const AREAS: AreaPreset[] = [
  {
    id: "walk-in",
    label: "Freezer & cold",
    icon: Snowflake,
    blurb: "Ice cream base, cream, fruit",
    categories: ["dairy", "fruit"]
  },
  {
    id: "dry",
    label: "Dry storage",
    icon: Package,
    blurb: "Powders, sugar, syrups",
    categories: ["powder", "sweetener"]
  },
  {
    id: "bar",
    label: "Toppings & extras",
    icon: Wine,
    blurb: "Boba, jellies, other food",
    categories: ["topping", "food"]
  },
  {
    id: "smallwares",
    label: "Smallwares",
    icon: Box,
    blurb: "Cups, straws, napkins, supplies",
    categories: ["packaging", "supplies"]
  }
];

type ScopeKind = "area" | "category" | "all";

interface CountEntry {
  qty?: number | null;
  skipped?: boolean;
  photo?: boolean;
  note?: string;
}

interface Session {
  status: "counting" | "summary";
  cursor: number;
  counts: Record<string, CountEntry>;
  startedAt: number;
  scopeKind: ScopeKind;
  scopeId: string;
  scopeLabel: string;
  itemIds: string[];
  blind: boolean;
}

type Action =
  | { type: "start"; payload: Omit<Session, "status" | "cursor" | "counts" | "startedAt"> }
  | { type: "resume"; payload: Session }
  | { type: "record"; id: string; qty: number }
  | { type: "skip"; id: string }
  | { type: "goto"; cursor: number }
  | { type: "togglePhoto"; id: string }
  | { type: "setNote"; id: string; note: string }
  | { type: "finish" }
  | { type: "reset" };

function reducer(state: Session | null, action: Action): Session | null {
  switch (action.type) {
    case "start":
      return {
        status: "counting",
        cursor: 0,
        counts: {},
        startedAt: Date.now(),
        ...action.payload
      };
    case "resume":
      return { ...action.payload, status: "counting" };
    case "record":
      if (!state) return state;
      return {
        ...state,
        counts: {
          ...state.counts,
          [action.id]: { ...(state.counts[action.id] ?? {}), qty: action.qty, skipped: false }
        }
      };
    case "skip":
      if (!state) return state;
      return {
        ...state,
        counts: {
          ...state.counts,
          [action.id]: { ...(state.counts[action.id] ?? {}), qty: null, skipped: true }
        }
      };
    case "goto":
      if (!state) return state;
      return { ...state, cursor: action.cursor };
    case "togglePhoto":
      if (!state) return state;
      return {
        ...state,
        counts: {
          ...state.counts,
          [action.id]: {
            ...(state.counts[action.id] ?? {}),
            photo: !(state.counts[action.id]?.photo ?? false)
          }
        }
      };
    case "setNote":
      if (!state) return state;
      return {
        ...state,
        counts: { ...state.counts, [action.id]: { ...(state.counts[action.id] ?? {}), note: action.note } }
      };
    case "finish":
      if (!state) return state;
      return { ...state, status: "summary" };
    case "reset":
      return null;
    default:
      return state;
  }
}

function loadSession(): Session | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

function saveSession(session: Session | null) {
  if (typeof window === "undefined") return;
  try {
    if (session) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore quota / disabled storage; in-memory state remains the source of truth.
  }
}

function varianceTier(actual: number | null, theoretical: number): "tight" | "warn" | "major" | "neutral" {
  if (actual == null || theoretical === 0) return "neutral";
  const pct = Math.abs((actual - theoretical) / Math.max(theoretical, 0.01));
  if (pct < 0.02) return "tight";
  if (pct < 0.1) return "warn";
  return "major";
}

const TIER_COLOR: Record<ReturnType<typeof varianceTier>, string> = {
  tight: "text-trend-up",
  warn: "text-amber-600 dark:text-amber-400",
  major: "text-trend-down",
  neutral: "text-muted-foreground"
};

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

function NumberPad({
  value,
  onChange,
  onConfirm,
  confirmDisabled,
  confirmLabel
}: {
  value: string;
  onChange: (v: string) => void;
  onConfirm: () => void;
  confirmDisabled: boolean;
  confirmLabel: string;
}) {
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "Backspace"];

  const press = (k: string) => {
    if (k === "Backspace") {
      onChange(value.length ? value.slice(0, -1) : "");
      return;
    }
    if (k === "." && value.includes(".")) return;
    if (value === "0" && k !== ".") {
      onChange(k);
      return;
    }
    onChange((value ?? "") + k);
  };

  return (
    <div className="grid grid-cols-3 gap-1.5">
      {keys.map((k) => (
        <button
          key={k}
          onClick={() => press(k)}
          className={cn(
            "h-11 select-none rounded-lg font-medium text-lg tabular-nums transition active:scale-[0.98] sm:h-12",
            "bg-secondary text-foreground hover:bg-secondary/80",
            k === "Backspace" && "text-muted-foreground"
          )}
        >
          {k === "Backspace" ? "⌫" : k}
        </button>
      ))}
      <button
        onClick={onConfirm}
        disabled={confirmDisabled}
        className={cn(
          "col-span-3 mt-0.5 flex h-11 items-center justify-center gap-2 rounded-lg font-medium text-sm transition active:scale-[0.99] sm:h-12",
          "bg-foreground text-background hover:opacity-90",
          "disabled:pointer-events-none disabled:opacity-40"
        )}
      >
        {confirmLabel}
        <ChevronRight className="size-4" />
      </button>
    </div>
  );
}

function VarianceLine({
  actual,
  theoretical,
  costCents,
  unit,
  blind
}: {
  actual: number | null;
  theoretical: number;
  costCents: number;
  unit: string;
  blind: boolean;
}) {
  if (actual == null || blind) return null;
  const diff = actual - theoretical;
  const pct = theoretical === 0 ? 0 : (diff / theoretical) * 100;
  const tier = varianceTier(actual, theoretical);
  const dollar = Math.abs(diff) * costCents;
  const sign = diff >= 0 ? "+" : "-";

  return (
    <div
      className={cn(
        "flex items-baseline justify-center gap-3 text-sm",
        TIER_COLOR[tier]
      )}
    >
      <span className="font-mono font-medium tabular-nums">
        {sign}
        {Math.abs(diff).toFixed(diff % 1 ? 1 : 0)} {unit}
      </span>
      <span className="text-muted-foreground">·</span>
      <span className="font-mono tabular-nums">
        {sign}
        {Math.abs(pct).toFixed(1)}%
      </span>
      <span className="text-muted-foreground">·</span>
      <span className="font-mono font-medium tabular-nums">
        {sign}
        {formatCents(dollar)}
      </span>
    </div>
  );
}

function CountSetup({
  data,
  hasResume,
  onResume,
  onStart
}: {
  data: InventoryDataset;
  hasResume: { scopeLabel: string; done: number; total: number } | null;
  onResume: () => void;
  onStart: (payload: Omit<Session, "status" | "cursor" | "counts" | "startedAt">) => void;
}) {
  const [scopeKind, setScopeKind] = React.useState<ScopeKind>("area");
  const [scopeId, setScopeId] = React.useState<string>("walk-in");
  const [blind, setBlind] = React.useState(false);

  const itemsInScope = React.useMemo(() => {
    if (scopeKind === "all") return data.items;
    if (scopeKind === "category") return data.items.filter((it) => it.category === scopeId);
    const area = AREAS.find((a) => a.id === scopeId);
    return area ? data.items.filter((it) => area.categories.includes(it.category)) : [];
  }, [data.items, scopeKind, scopeId]);

  const estMinutes = Math.max(1, Math.round(itemsInScope.length * 0.5));
  const scopeLabel =
    scopeKind === "all"
      ? "All items"
      : scopeKind === "category"
        ? data.categories.find((c) => c.id === scopeId)?.name ?? scopeId
        : AREAS.find((a) => a.id === scopeId)?.label ?? scopeId;

  const begin = () => {
    onStart({
      scopeKind,
      scopeId,
      scopeLabel,
      itemIds: itemsInScope.map((i) => i.id),
      blind
    });
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-6 overflow-y-auto px-4 py-5 sm:px-6">
        {hasResume && (
          <div className="rounded-xl border border-accent/40 bg-trend-up-bg/40 p-4">
            <div className="flex items-start gap-3">
              <div className="flex size-9 flex-none items-center justify-center rounded-md bg-accent/15">
                <CircleDot className="size-4 text-accent" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">Count in progress</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {hasResume.scopeLabel} · {hasResume.done} / {hasResume.total} items
                </div>
              </div>
              <Button onClick={onResume}>
                Resume<ChevronRight className="size-3.5" />
              </Button>
            </div>
          </div>
        )}

        <section>
          <h3 className="mb-2 text-sm font-medium">What are you counting?</h3>
          <div className="grid grid-cols-2 gap-2">
            {AREAS.map((a) => {
              const n = data.items.filter((it) => a.categories.includes(it.category)).length;
              const active = scopeKind === "area" && scopeId === a.id;
              return (
                <button
                  key={a.id}
                  onClick={() => {
                    setScopeKind("area");
                    setScopeId(a.id);
                  }}
                  className={cn(
                    "rounded-xl border p-3.5 text-left transition",
                    active
                      ? "border-foreground/40 bg-secondary"
                      : "border-border bg-card hover:bg-secondary/50"
                  )}
                >
                  <a.icon
                    className={cn("size-5", active ? "text-foreground" : "text-muted-foreground")}
                  />
                  <div className="mt-2.5 text-sm font-medium">{a.label}</div>
                  <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                    {a.blurb}
                  </div>
                  <div className="mt-1.5 font-mono text-[11px] tabular-nums text-muted-foreground">
                    {n} items
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        <section>
          <h3 className="mb-2 text-sm font-medium">Or pick a category</h3>
          <div className="flex flex-wrap gap-1.5">
            {data.categories.map((c) => {
              const n = data.items.filter((it) => it.category === c.id).length;
              const active = scopeKind === "category" && scopeId === c.id;
              return (
                <button
                  key={c.id}
                  onClick={() => {
                    setScopeKind("category");
                    setScopeId(c.id);
                  }}
                  className={cn(
                    "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition",
                    active
                      ? "border-foreground/40 bg-secondary text-foreground"
                      : "border-border bg-background text-muted-foreground hover:bg-secondary/60"
                  )}
                >
                  {c.name}
                  <span className="font-mono tabular-nums opacity-70">{n}</span>
                </button>
              );
            })}
            <button
              onClick={() => {
                setScopeKind("all");
                setScopeId("all");
              }}
              className={cn(
                "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition",
                scopeKind === "all"
                  ? "border-foreground/40 bg-secondary text-foreground"
                  : "border-border bg-background text-muted-foreground hover:bg-secondary/60"
              )}
            >
              All items
              <span className="font-mono tabular-nums opacity-70">{data.items.length}</span>
            </button>
          </div>
        </section>

        <section className="rounded-xl border border-border p-4">
          <div className="flex items-start gap-3">
            <div className="flex size-9 flex-none items-center justify-center rounded-md bg-secondary">
              <EyeOff className="size-4 text-muted-foreground" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-medium">Blind count</div>
                <button
                  role="switch"
                  aria-checked={blind}
                  onClick={() => setBlind((b) => !b)}
                  className={cn(
                    "relative h-6 w-11 rounded-full transition-colors",
                    blind ? "bg-accent" : "border border-border bg-secondary"
                  )}
                >
                  <span
                    className={cn(
                      "absolute top-0.5 size-5 rounded-full bg-white shadow transition-transform",
                      blind ? "translate-x-5" : "translate-x-0.5"
                    )}
                  />
                </button>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Hide the system&apos;s theoretical on-hand. You&apos;ll count what you see; the
                variance shows up only after you submit each item.
              </p>
            </div>
          </div>
        </section>
      </div>

      <footer
        className="flex flex-none items-center gap-3 border-t border-border bg-background px-4 py-3 sm:px-6"
        style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}
      >
        <div className="min-w-0 flex-1">
          <div className="text-xs text-muted-foreground">Counting</div>
          <div className="truncate text-sm font-medium">
            {scopeLabel} ·{" "}
            <span className="font-mono tabular-nums">{itemsInScope.length}</span> items
          </div>
          <div className="text-[11px] text-muted-foreground">~{estMinutes} min estimate</div>
        </div>
        <Button onClick={begin} disabled={itemsInScope.length === 0}>
          Start count
          <ChevronRight className="size-4" />
        </Button>
      </footer>
    </div>
  );
}

function CountRun({
  data,
  session,
  dispatch,
  onFinish
}: {
  data: InventoryDataset;
  session: Session;
  dispatch: React.Dispatch<Action>;
  onFinish: () => void;
}) {
  const items = session.itemIds
    .map((id) => data.items.find((it) => it.id === id))
    .filter((it): it is InventoryItem => Boolean(it));
  const cursor = session.cursor;
  const item = items[cursor];

  // Per React docs (adjusting some state when a prop changes), reset the
  // typed-in input whenever the cursor lands on a different item, but pre-fill
  // from session.counts so navigating back to an already-counted item shows
  // the recorded value. Doing this via render-time derived state instead of a
  // useEffect avoids the cascading-render warning.
  const [input, setInput] = React.useState(() => {
    const prev = item ? session.counts[item.id] : null;
    return prev?.qty != null ? String(prev.qty) : "";
  });
  const [lastItemId, setLastItemId] = React.useState<string | undefined>(item?.id);
  if (item?.id !== lastItemId) {
    setLastItemId(item?.id);
    const prev = item ? session.counts[item.id] : null;
    setInput(prev?.qty != null ? String(prev.qty) : "");
  }

  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, []);

  const runningVarianceCents = React.useMemo(() => {
    return Object.entries(session.counts).reduce((sum, [id, c]) => {
      if (c.qty == null) return sum;
      const it = data.items.find((x) => x.id === id);
      if (!it) return sum;
      return sum + (c.qty - it.on_hand) * it.cost_cents;
    }, 0);
  }, [session.counts, data.items]);

  if (!item) return null;
  const numeric = input === "" ? null : parseFloat(input);
  const isValid = numeric != null && !Number.isNaN(numeric) && numeric >= 0;
  const tier = numeric == null ? "neutral" : varianceTier(numeric, item.on_hand);
  const needsNote = tier === "major";

  const confirm = () => {
    if (numeric == null || !isValid) return;
    dispatch({ type: "record", id: item.id, qty: numeric });
    const nextUncounted = items.findIndex(
      (it, i) => i > cursor && !session.counts[it.id]?.qty
    );
    if (nextUncounted >= 0) {
      dispatch({ type: "goto", cursor: nextUncounted });
    } else if (cursor < items.length - 1) {
      dispatch({ type: "goto", cursor: cursor + 1 });
    } else {
      onFinish();
    }
  };

  const skip = () => {
    dispatch({ type: "skip", id: item.id });
    if (cursor < items.length - 1) dispatch({ type: "goto", cursor: cursor + 1 });
    else onFinish();
  };

  const move = (delta: number) => {
    const next = Math.max(0, Math.min(items.length - 1, cursor + delta));
    if (next !== cursor) dispatch({ type: "goto", cursor: next });
  };

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-4 pb-2 pt-3 sm:px-6">
        <div className="flex items-baseline justify-between gap-3 text-sm">
          <span className="whitespace-nowrap font-mono tabular-nums">
            <span className="font-medium">{cursor + 1}</span>
            <span className="text-muted-foreground"> / {items.length}</span>
          </span>
          <span className="whitespace-nowrap font-mono text-xs tabular-nums text-muted-foreground">
            {fmtElapsed(now - session.startedAt)}
          </span>
          <span
            className={cn(
              "whitespace-nowrap font-mono text-sm font-medium tabular-nums",
              runningVarianceCents > 0
                ? "text-trend-up"
                : runningVarianceCents < 0
                  ? "text-trend-down"
                  : "text-muted-foreground"
            )}
          >
            {runningVarianceCents >= 0 ? "+" : "-"}
            {formatCents(Math.abs(runningVarianceCents))}
          </span>
        </div>
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-secondary">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-300"
            style={{ width: `${(cursor / Math.max(items.length, 1)) * 100}%` }}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 sm:px-6 sm:py-5">
        <div className="text-center">
          <div className="mx-auto mb-2 flex size-10 items-center justify-center rounded-lg bg-secondary">
            <Package className="size-5 text-muted-foreground" />
          </div>
          <h2 className="text-lg font-medium leading-tight tracking-tight">{item.name}</h2>
          <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
            {item.sku} · <span className="capitalize">{item.category}</span>
          </div>
          <div className="mt-2.5 flex flex-wrap items-center justify-center gap-4 text-xs">
            {!session.blind && (
              <div className="text-center">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Theoretical
                </div>
                <div className="font-mono font-medium tabular-nums">
                  {item.on_hand}{" "}
                  <span className="text-[10px] text-muted-foreground">{item.unit}</span>
                </div>
              </div>
            )}
            <div className="text-center">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Par
              </div>
              <div className="font-mono font-medium tabular-nums">
                {item.par_min}/{item.par_max}
              </div>
            </div>
            <div className="text-center">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Last
              </div>
              <div className="font-mono tabular-nums">{item.last_counted}</div>
            </div>
          </div>

          <div className="mt-4">
            <div className="mb-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
              You counted
            </div>
            <div className="font-mono text-4xl font-medium leading-none tabular-nums sm:text-5xl">
              {input || <span className="text-muted-foreground/40">0</span>}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">{item.unit}</div>
          </div>

          <div className="mt-2 min-h-[18px]">
            <VarianceLine
              actual={numeric}
              theoretical={item.on_hand}
              costCents={item.cost_cents}
              unit={item.unit}
              blind={session.blind}
            />
          </div>
        </div>

        {needsNote && (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs dark:border-amber-900/60 dark:bg-amber-950/40">
            <span className="text-amber-900 dark:text-amber-200">
              That&apos;s a &gt;10% swing from theoretical. Add a photo or note before confirming.
            </span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-1 border-t border-border bg-background px-3 py-1.5 sm:px-6">
        <button
          onClick={() => move(-1)}
          disabled={cursor === 0}
          className="flex size-10 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary disabled:opacity-30"
          aria-label="Previous item"
        >
          <ChevronLeft className="size-5" />
        </button>
        <button
          onClick={skip}
          className="h-10 rounded-lg px-3 text-xs font-medium text-muted-foreground hover:bg-secondary"
        >
          Skip
        </button>
        <div className="flex-1" />
        <button
          onClick={() => dispatch({ type: "togglePhoto", id: item.id })}
          className={cn(
            "flex size-10 items-center justify-center rounded-lg",
            session.counts[item.id]?.photo
              ? "bg-accent/15 text-accent"
              : "text-muted-foreground hover:bg-secondary"
          )}
          aria-label="Attach photo"
          title="Attach photo"
        >
          <Camera className="size-5" />
        </button>
        <button
          onClick={() => {
            const note = window.prompt("Add a note for this count");
            if (note != null) dispatch({ type: "setNote", id: item.id, note });
          }}
          className={cn(
            "flex size-10 items-center justify-center rounded-lg",
            session.counts[item.id]?.note
              ? "bg-accent/15 text-accent"
              : "text-muted-foreground hover:bg-secondary"
          )}
          aria-label="Add note"
          title="Add note"
        >
          <Pencil className="size-5" />
        </button>
        <button
          onClick={() => move(1)}
          disabled={cursor === items.length - 1}
          className="flex size-10 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary disabled:opacity-30"
          aria-label="Next item"
        >
          <ChevronRight className="size-5" />
        </button>
      </div>

      <div
        className="border-t border-border bg-background px-3 pb-2 pt-1.5 sm:px-6"
        style={{ paddingBottom: "calc(0.5rem + env(safe-area-inset-bottom))" }}
      >
        <NumberPad
          value={input}
          onChange={setInput}
          onConfirm={confirm}
          confirmDisabled={!isValid}
          confirmLabel={cursor === items.length - 1 ? "Finish count" : "Confirm & next"}
        />
      </div>
    </div>
  );
}

function CountSummary({
  data,
  session,
  onAdjust,
  onClose
}: {
  data: InventoryDataset;
  session: Session;
  onAdjust: () => void;
  onClose: () => void;
}) {
  const rows = session.itemIds
    .map((id) => {
      const it = data.items.find((x) => x.id === id);
      const c = session.counts[id];
      if (!it || !c || c.qty == null) return null;
      const diff = c.qty - it.on_hand;
      const dollar = diff * it.cost_cents;
      return { id, item: it, counted: c.qty, diff, dollar, note: c.note, photo: c.photo };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  const skipped = session.itemIds.filter((id) => session.counts[id]?.skipped).length;
  const totalDollar = rows.reduce((s, r) => s + r.dollar, 0);
  const top = [...rows].sort((a, b) => Math.abs(b.dollar) - Math.abs(a.dollar)).slice(0, 5);

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-5 overflow-y-auto px-4 py-5 sm:px-6">
        <section className="pt-2 text-center">
          <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-accent/15">
            <CheckCircle className="size-6 text-accent" />
          </div>
          <h2 className="text-2xl font-medium tracking-tight">Count complete</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {session.scopeLabel} · {rows.length} of {session.itemIds.length} items counted
            {skipped > 0 && (
              <>
                {" "}·{" "}
                <span className="text-amber-700 dark:text-amber-300">{skipped} skipped</span>
              </>
            )}
          </p>
        </section>

        <section className="rounded-xl border border-border p-4">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">
            Net variance to COGS
          </div>
          <div
            className={cn(
              "mt-1 font-mono text-3xl font-medium tabular-nums",
              totalDollar < -500
                ? "text-trend-down"
                : totalDollar > 500
                  ? "text-trend-up"
                  : ""
            )}
          >
            {totalDollar < 0 ? "-" : "+"}
            {formatCents(Math.abs(totalDollar))}
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">
            Negative variance means actual stock is lower than the system thought — shrink,
            miscount, or unrecorded usage.
          </p>
        </section>

        <section>
          <h3 className="mb-2 text-sm font-medium">Top discrepancies</h3>
          {top.length === 0 ? (
            <p className="text-sm text-muted-foreground">No items counted yet.</p>
          ) : (
            <div className="space-y-1.5">
              {top.map((r) => {
                const tier = varianceTier(r.counted, r.item.on_hand);
                return (
                  <div
                    key={r.id}
                    className="flex items-center gap-3 rounded-lg border border-border p-3"
                  >
                    <div
                      className={cn(
                        "flex size-9 flex-none items-center justify-center rounded-md",
                        tier === "major"
                          ? "bg-trend-down-bg text-trend-down"
                          : tier === "warn"
                            ? "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
                            : "bg-secondary text-muted-foreground"
                      )}
                    >
                      <Package className="size-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{r.item.name}</div>
                      <div className="font-mono text-xs tabular-nums text-muted-foreground">
                        was {r.item.on_hand} · counted {r.counted} {r.item.unit}
                      </div>
                    </div>
                    <div className="text-right">
                      <div
                        className={cn(
                          "font-mono text-sm font-medium tabular-nums",
                          r.dollar < 0 ? "text-trend-down" : "text-trend-up"
                        )}
                      >
                        {r.dollar < 0 ? "-" : "+"}
                        {formatCents(Math.abs(r.dollar))}
                      </div>
                      <div className="font-mono text-[11px] tabular-nums text-muted-foreground">
                        {r.diff > 0 ? "+" : ""}
                        {r.diff.toFixed(r.diff % 1 ? 1 : 0)} {r.item.unit}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="rounded-xl border border-border bg-secondary/30 p-4">
          <div className="text-sm font-medium">After you submit</div>
          <ul className="mt-2 space-y-1.5 text-xs text-muted-foreground">
            <li className="flex items-start gap-2">
              <CheckCircle className="mt-0.5 size-3.5 flex-none text-muted-foreground" />
              On-hand counts overwrite the system&apos;s theoretical values.
            </li>
            <li className="flex items-start gap-2">
              <CheckCircle className="mt-0.5 size-3.5 flex-none text-muted-foreground" />
              Items now below par get queued for the next PO suggestion.
            </li>
            <li className="flex items-start gap-2">
              <CheckCircle className="mt-0.5 size-3.5 flex-none text-muted-foreground" />
              Major variances notify the GM for sign-off.
            </li>
          </ul>
        </section>
      </div>

      <footer
        className="flex flex-none items-center gap-2 border-t border-border bg-background px-4 py-3 sm:px-6"
        style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}
      >
        <Button variant="outline" onClick={onClose}>
          Discard
        </Button>
        <div className="flex-1" />
        <Button onClick={onAdjust}>
          <CheckCircle className="size-4" />
          Submit &amp; adjust
        </Button>
      </footer>
    </div>
  );
}

export interface CountModeModalProps {
  open: boolean;
  data: InventoryDataset;
  onAdjustItems: (updates: Record<string, number>) => void;
  onClose: () => void;
}

export function CountModeModal({ open, data, onAdjustItems, onClose }: CountModeModalProps) {
  const mobile = useIsMobile();
  const [session, dispatch] = React.useReducer(reducer, null, loadSession);

  React.useEffect(() => {
    saveSession(session);
  }, [session]);

  const status = session?.status ?? "setup";

  const handleAdjust = () => {
    if (!session) return;
    const updates: Record<string, number> = {};
    for (const [id, c] of Object.entries(session.counts)) {
      if (c.qty != null && !c.skipped) updates[id] = c.qty;
    }
    onAdjustItems(updates);
    dispatch({ type: "reset" });
    onClose();
  };

  const handleDiscard = () => {
    dispatch({ type: "reset" });
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        showCloseButton={false}
        className={cn(
          "z-[60] flex flex-col gap-0 overflow-hidden p-0",
          mobile
            ? "left-0 top-0 max-h-none max-w-none translate-x-0 translate-y-0 rounded-none ring-0"
            : "left-1/2 top-1/2 h-[760px] max-h-[90vh] max-w-[680px] -translate-x-1/2 -translate-y-1/2 rounded-2xl sm:max-w-[680px]"
        )}
        style={mobile ? { width: "100vw", height: "100vh" } : undefined}
      >
        <DialogTitle className="sr-only">Physical count</DialogTitle>
        <header className="flex h-12 flex-none items-center gap-3 border-b border-border px-4 sm:px-6">
          {status === "counting" ? (
            <button
              onClick={() => {
                if (window.confirm("Pause and resume later?")) onClose();
              }}
              className="-ml-2 flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary"
              aria-label="Pause and exit"
            >
              <ChevronLeft className="size-5" />
            </button>
          ) : null}
          <div className="min-w-0 flex-1">
            <div className="text-xs text-muted-foreground">
              {status === "setup" ? "Start a count" : status === "counting" ? "Counting" : "Review"}
            </div>
            <div className="truncate text-sm font-medium">
              {session?.scopeLabel || "Physical count"}
            </div>
          </div>
          <button
            onClick={onClose}
            className="-mr-2 flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary"
            aria-label="Close"
          >
            <X className="size-5" />
          </button>
        </header>

        {status === "setup" && (
          <CountSetup
            data={data}
            hasResume={(() => {
              const resume = loadSession();
              if (!resume) return null;
              return {
                scopeLabel: resume.scopeLabel,
                done: Object.values(resume.counts ?? {}).filter((c) => c?.qty != null).length,
                total: resume.itemIds?.length ?? 0
              };
            })()}
            onResume={() => {
              const resume = loadSession();
              if (resume) dispatch({ type: "resume", payload: resume });
            }}
            onStart={(payload) => dispatch({ type: "start", payload })}
          />
        )}
        {status === "counting" && session && (
          <CountRun
            data={data}
            session={session}
            dispatch={dispatch}
            onFinish={() => dispatch({ type: "finish" })}
          />
        )}
        {status === "summary" && session && (
          <CountSummary
            data={data}
            session={session}
            onAdjust={handleAdjust}
            onClose={handleDiscard}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
