"use client";

import { useState } from "react";

import { applyCount, writeFailureReason, type WriteFailure } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useCrewData } from "@/lib/crew-data";
import { useIdempotencyKey } from "@/lib/use-idempotency-key";
import { FlowSuccess } from "./flow-success";
import { ItemThumb } from "./item-thumb";
import { STRINGS, writeFailureKey } from "@/lib/strings";
import type { Lang } from "@/lib/types";
import { useCrewSize } from "@/lib/use-crew-size";

// Reconteo (design handoff §5) — single screen: every item shows its system count
// and an actual-count input; a variance badge shows the diff (hidden on phone to
// save width). Guardar conteo commits all changed lines in one count submission.
// Inputs sit in a fixed-width right column so they don't shift with unit length.
export function RecountFlow({
  lang,
  onDone,
  onChanged,
  showToast,
}: {
  lang: Lang;
  onDone: () => void;
  onChanged?: () => void | Promise<void>;
  // App-level toast (crew-app) — confirms "Change undone" after a flow undo.
  showToast?: (msg: string) => void;
}) {
  const T = STRINGS[lang];
  const phone = useCrewSize().kind === "phone";
  const { items } = useCrewData();

  const [vals, setVals] = useState<Record<string, string>>({});
  const [q, setQ] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<WriteFailure | null>(null);
  const { keyFor } = useIdempotencyKey();
  // Undo (design handoff §3): its own key holder + a snapshot of the pre-count
  // on_hand for every line we changed, so the reversal re-applies those exact
  // values with a fresh idempotency key. Counts are absolute, so this is a clean,
  // idempotent restore (unlike waste, no offsetting-ledger caveat).
  const { keyFor: undoKeyFor } = useIdempotencyKey();
  const [undoFrom, setUndoFrom] = useState<Record<string, number> | null>(null);
  const [undoCount, setUndoCount] = useState(0);
  const [undoing, setUndoing] = useState(false);
  const [undoError, setUndoError] = useState<WriteFailure | null>(null);

  const changed = (id: string, onHand: number) => {
    const v = vals[id];
    return v !== undefined && v !== "" && Number(v) !== onHand;
  };
  const entries = items.filter((it) => changed(it.id, it.on_hand));

  if (done) {
    const undoRecount = async () => {
      if (!undoFrom || undoing) return;
      setUndoing(true);
      setUndoError(null);
      try {
        const key = undoKeyFor(`Undo recount|${JSON.stringify(undoFrom)}`);
        await applyCount(undoFrom, "Undo recount", key);
        await onChanged?.();
        showToast?.(T.flow_undone);
        onDone();
      } catch (e) {
        setUndoError(writeFailureReason(e));
        setUndoing(false);
      }
    };
    return (
      <FlowSuccess
        title={T.rco_done}
        sub={`${undoCount} ${T.rco_count}`}
        doneLabel={T.done}
        onDone={onDone}
        onUndo={undoFrom ? undoRecount : undefined}
        undoLabel={T.undo}
        busy={undoing}
        error={undoError ? T[writeFailureKey(undoError)] : null}
      />
    );
  }

  const ql = q.trim().toLowerCase();
  const rows = items.filter((it) => !ql || it.name.toLowerCase().includes(ql) || it.sku.toLowerCase().includes(ql));
  const errText = error ? T[writeFailureKey(error)] : null;

  const save = async () => {
    if (!entries.length || busy) return;
    setBusy(true);
    setError(null);
    try {
      const updates: Record<string, number> = {};
      // Pre-count on_hand for the same lines — the Undo restore target. Captured
      // before the refetch, which moves on_hand onto the new counts (after which
      // `entries` recomputes to empty — so the count is snapshotted here too).
      const before: Record<string, number> = {};
      entries.forEach((it) => {
        updates[it.id] = Math.max(0, Number(vals[it.id]));
        before[it.id] = it.on_hand;
      });
      // `entries` derives from `items` (stable order), so the same edited counts
      // serialize identically on a re-tap → same key; changing any count re-keys.
      const key = keyFor(`Recount|${JSON.stringify(updates)}`);
      await applyCount(updates, "Recount", key);
      await onChanged?.();
      setUndoFrom(before);
      setUndoCount(entries.length);
      setDone(true);
    } catch (e) {
      setError(writeFailureReason(e));
      setBusy(false);
    }
  };

  return (
    <div className="h-full flex flex-col bg-zinc-50">
      <div className={cn(phone ? "px-4 pt-3.5" : "px-10 pt-4")}>
        <h2 className={cn("font-semibold tracking-tight text-zinc-900", phone ? "text-xl" : "text-3xl")}>
          {T.rco_title}
        </h2>
        <p className={cn("text-zinc-500 mt-1", phone ? "text-sm" : "text-base")}>{T.rco_sub}</p>
      </div>

      <div className={cn("pt-2", phone ? "px-4" : "px-10")}>
        <div
          className="flex items-center gap-2.5 rounded-2xl bg-white border border-zinc-200 px-4"
          style={{ height: phone ? 58 : 52 }}
        >
          <SearchIcon className="size-5 text-zinc-400 flex-none" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={T.items_search_ph}
            className="flex-1 bg-transparent border-0 outline-none text-base"
          />
        </div>
      </div>

      <div className={cn("flex-1 overflow-y-auto grid gap-2.5 content-start pt-3", phone ? "px-4 pb-3 grid-cols-1" : "px-10 pb-3 grid-cols-2")}>
        {rows.map((it) => {
          const v = vals[it.id] ?? "";
          const diff = v !== "" ? Number(v) - it.on_hand : null;
          return (
            <div key={it.id} className="flex items-center gap-4 bg-white border border-zinc-200 rounded-[18px] p-3.5">
              <ItemThumb item={it} className="size-13 text-2xl flex-none" rounded="rounded-2xl" />
              <div className="flex-1 min-w-0">
                <div className="text-[17px] font-semibold text-zinc-900 truncate">{it.name}</div>
                <div className="font-mono text-xs text-zinc-400 mt-0.5 tabular-nums">
                  {T.rco_system}: {it.on_hand} {it.unit}
                </div>
              </div>
              {!phone && diff !== null && diff !== 0 && (
                <span
                  className={cn(
                    "font-mono font-bold text-sm px-2.5 py-1 rounded-[10px] flex-none",
                    diff > 0 ? "text-emerald-700 bg-emerald-50" : "text-orange-700 bg-orange-50",
                  )}
                >
                  {diff > 0 ? "+" : ""}
                  {diff}
                </span>
              )}
              <div className="flex items-center gap-2 flex-none">
                <input
                  type="number"
                  inputMode="numeric"
                  placeholder={String(it.on_hand)}
                  value={v}
                  onChange={(e) => setVals((s) => ({ ...s, [it.id]: e.target.value }))}
                  className="w-24 h-13 rounded-[14px] border border-zinc-200 px-3.5 text-center font-mono text-xl outline-none focus:border-violet-500"
                  style={{ height: 52 }}
                />
                <span className="text-xs text-zinc-500 w-8">{it.unit}</span>
              </div>
            </div>
          );
        })}
      </div>

      <div
        className={cn("shrink-0 border-t border-zinc-100 bg-zinc-50", phone ? "px-4 py-3.5" : "px-10 py-4")}
        style={{ paddingBottom: phone ? "calc(0.875rem + env(safe-area-inset-bottom))" : undefined }}
      >
        {errText && <div className="text-center text-sm text-red-600 mb-2">{errText}</div>}
        <button
          onClick={save}
          disabled={!entries.length || busy}
          className="w-full h-16 rounded-2xl text-white font-semibold text-lg inline-flex items-center justify-center gap-2 disabled:bg-zinc-200 disabled:text-zinc-400"
          style={entries.length && !busy ? { background: "#1F8A5B", boxShadow: "0 12px 30px -8px rgba(31,138,91,.45)" } : undefined}
        >
          ✓ {T.rco_save} ({entries.length})
        </button>
      </div>
    </div>
  );
}

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}
