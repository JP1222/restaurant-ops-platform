"use client";

import { useState } from "react";

import { applyCount, recordWaste, writeFailureReason, type WriteFailure } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useCrewData } from "@/lib/crew-data";
import { useIdempotencyKey } from "@/lib/use-idempotency-key";
import { money } from "@/lib/crew-status";
import { REASON_GLYPHS } from "@/lib/employees";
import { FlowSuccess } from "./flow-success";
import { ItemThumb } from "./item-thumb";
import { STRINGS, writeFailureKey, type StringKey } from "@/lib/strings";
import type { Lang } from "@/lib/types";
import { useCrewSize } from "@/lib/use-crew-size";

// Merma (design handoff §5) — single screen: a searchable item list; tapping an
// item docks a bottom panel (qty stepper + reason chips + Registrar merma) and
// subtracts on_hand via recordWaste. The manager photo-evidence gate is preserved:
// a high-value waste can't be logged until a photo is marked attached.
export function WasteFlow({
  lang,
  onDone,
  onChanged,
  showToast,
}: {
  lang: Lang;
  onDone: () => void;
  onChanged?: () => void | Promise<void>;
  // App-level toast (crew-app) — used to confirm "Change undone" after a flow undo.
  showToast?: (msg: string) => void;
}) {
  const T = STRINGS[lang];
  const phone = useCrewSize().kind === "phone";
  const { items, wasteReasons, wasteSettings } = useCrewData();

  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [qty, setQty] = useState(1);
  const [reason, setReason] = useState<string | null>(null);
  const [photo, setPhoto] = useState(false);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<WriteFailure | null>(null);
  const { keyFor } = useIdempotencyKey();
  // Undo (design handoff §3): a separate key holder so the reversal mints its OWN
  // idempotency key — reusing the waste's key would make inventory-api replay the
  // waste result, not apply the correction.
  const { keyFor: undoKeyFor } = useIdempotencyKey();
  // on_hand captured the instant before the waste committed; the undo re-applies it.
  const [undoFrom, setUndoFrom] = useState<number | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [undoError, setUndoError] = useState<WriteFailure | null>(null);

  const item = items.find((it) => it.id === sel) ?? null;

  if (done && item) {
    // Reverse the just-committed waste by re-applying the pre-waste count. The waste
    // ledger row stays (it's an immutable, audit-grade record — there's no void
    // endpoint), so this is an offsetting correction, not a true delete: stock lands
    // back where it was while the history honestly shows "wasted, then corrected".
    const undoWaste = async () => {
      if (undoFrom === null || undoing) return;
      setUndoing(true);
      setUndoError(null);
      try {
        const key = undoKeyFor(`Undo waste|${item.id}|${undoFrom}`);
        await applyCount({ [item.id]: undoFrom }, "Undo waste", key);
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
        title={T.wst_done}
        sub={`${item.name} · −${qty} ${item.unit}`}
        doneLabel={T.done}
        onDone={onDone}
        onUndo={undoWaste}
        undoLabel={T.undo}
        busy={undoing}
        error={undoError ? T[writeFailureKey(undoError)] : null}
      />
    );
  }

  const ql = q.trim().toLowerCase();
  const rows = items.filter((it) => !ql || it.name.toLowerCase().includes(ql) || it.sku.toLowerCase().includes(ql));

  const cost = item ? Math.round(item.cost_cents * qty) : 0;
  const photoRequired = item ? cost >= wasteSettings.photo_required_over_cents : false;
  const canSubmit = Boolean(reason) && qty > 0 && (!photoRequired || photo);
  const errText = error ? T[writeFailureKey(error)] : null;

  const register = async () => {
    if (!item || !reason || !canSubmit || busy) return;
    setBusy(true);
    setError(null);
    // Snapshot on_hand before the write so Undo can restore it (the refetch below
    // moves item.on_hand to the post-waste value).
    const fromOnHand = item.on_hand;
    try {
      // Re-tap after an error reuses one key while the waste is unchanged; editing
      // qty / reason / the photo flag mints a fresh one (see useIdempotencyKey).
      const key = keyFor(`${item.id}|${qty}|${reason}|${photo}|${cost}`);
      await recordWaste({ sku: item.id, qty, reason, notes: "", photo, cost_cents: cost }, key);
      await onChanged?.();
      setUndoFrom(fromOnHand);
      setDone(true);
    } catch (e) {
      setError(writeFailureReason(e));
      setBusy(false);
    }
  };

  const pick = (id: string) => {
    setSel((cur) => (cur === id ? null : id));
    setQty(1);
    setReason(null);
    setPhoto(false);
  };

  return (
    <div className="h-full flex flex-col bg-zinc-50">
      <div className={cn(phone ? "px-4 pt-3.5" : "px-10 pt-4")}>
        <h2 className={cn("font-semibold tracking-tight text-zinc-900", phone ? "text-xl" : "text-3xl")}>
          {T.wst_title}
        </h2>
        <p className={cn("text-zinc-500 mt-1", phone ? "text-sm" : "text-base")}>{T.wst_pick}</p>
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
          const active = sel === it.id;
          return (
            <button
              key={it.id}
              onClick={() => pick(it.id)}
              className={cn(
                "flex items-center gap-4 bg-white border rounded-[18px] p-3.5 text-left",
                active ? "border-violet-500 ring-1 ring-violet-500" : "border-zinc-200",
              )}
            >
              <ItemThumb item={it} className="size-12 text-[23px] flex-none" rounded="rounded-2xl" />
              <div className="flex-1 min-w-0">
                <div className="text-[17px] font-semibold text-zinc-900 truncate">{it.name}</div>
                <div className="font-mono text-xs text-zinc-400 mt-0.5 tabular-nums">
                  {it.on_hand} {it.unit} {T.it_in_stock.toLowerCase()}
                </div>
              </div>
              <div
                className={cn(
                  "rounded-full border-2 flex items-center justify-center flex-none size-8",
                  active ? "text-white border-emerald-600" : "border-zinc-300 text-transparent",
                )}
                style={active ? { background: "#1F8A5B", borderColor: "#1F8A5B" } : undefined}
              >
                {active && <CheckIcon className="size-4" />}
              </div>
            </button>
          );
        })}
      </div>

      {item && (
        <div
          className={cn("shrink-0 border-t border-zinc-200 bg-white shadow-[0_-10px_30px_-16px_rgba(0,0,0,.18)]", phone ? "px-4 py-3.5" : "px-10 py-4")}
          style={{ paddingBottom: phone ? "calc(0.875rem + env(safe-area-inset-bottom))" : undefined }}
        >
          <div className="flex items-center gap-3.5 flex-wrap">
            <ItemThumb item={item} className="size-13 text-2xl flex-none" rounded="rounded-2xl" />
            <div className="flex-1 min-w-0">
              <div className="text-[17px] font-semibold text-zinc-900 truncate">{item.name}</div>
              <div className="font-mono text-xs text-zinc-400 mt-0.5 tabular-nums">
                {item.on_hand} {item.unit} {T.it_in_stock.toLowerCase()}
              </div>
            </div>
            <span className="text-sm font-semibold text-zinc-600">{T.wst_qty}</span>
            <div className="flex items-center gap-0.5 bg-zinc-100 rounded-2xl p-1 flex-none">
              <button onClick={() => setQty(Math.max(1, qty - 1))} className="size-13 rounded-xl grid place-items-center text-[26px] font-semibold active:bg-zinc-200">
                −
              </button>
              <input
                type="number"
                inputMode="numeric"
                value={qty}
                onChange={(e) => setQty(Math.max(1, parseInt(e.target.value || "1", 10)))}
                className="w-16 text-center bg-transparent border-0 outline-none font-mono text-2xl font-semibold [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
              <button onClick={() => setQty(qty + 1)} className="size-13 rounded-xl grid place-items-center text-[26px] font-semibold active:bg-zinc-200">
                +
              </button>
              <span className="text-xs text-zinc-500 pl-1 pr-2">{item.unit}</span>
            </div>
          </div>

          <div className="flex flex-wrap gap-2.5 mt-3.5">
            {wasteReasons.map((r) => {
              const active = reason === r.id;
              return (
                <button
                  key={r.id}
                  onClick={() => setReason(r.id)}
                  className={cn(
                    "inline-flex items-center gap-2 h-12 px-4.5 rounded-[14px] text-[15px] font-medium",
                    active ? "bg-zinc-800 text-white" : "bg-zinc-100 text-zinc-600",
                  )}
                >
                  <span className="text-lg">{REASON_GLYPHS[r.id] ?? "•"}</span>
                  {STRINGS[lang][("rsn_" + r.id) as StringKey]}
                </button>
              );
            })}
          </div>

          {photoRequired && (
            <button
              onClick={() => setPhoto((p) => !p)}
              className={cn(
                "mt-3 inline-flex items-center gap-2 h-12 px-4.5 rounded-[14px] text-[15px] font-medium border",
                photo ? "bg-emerald-50 border-emerald-200 text-emerald-800" : "bg-white border-amber-300 text-amber-700",
              )}
            >
              📷 {photo ? T.waste_photo_attached : T.waste_photo_take}
              {!photo && (
                <span className="text-xs font-normal text-amber-600">
                  · {T.waste_photo_required.replace("{amt}", money(wasteSettings.photo_required_over_cents))}
                </span>
              )}
            </button>
          )}

          {errText && <div className="text-sm text-red-600 mt-2">{errText}</div>}

          <button
            onClick={register}
            disabled={!canSubmit || busy}
            className="w-full h-15 mt-3.5 rounded-2xl text-white font-semibold text-lg inline-flex items-center justify-center gap-2 disabled:bg-zinc-200 disabled:text-zinc-400"
            style={{ ...(canSubmit && !busy ? { background: "#ef4444" } : {}), height: 60 }}
          >
            🗑 {T.wst_register} · −{qty} {item.unit}
          </button>
        </div>
      )}
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

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
