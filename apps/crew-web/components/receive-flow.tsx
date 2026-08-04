"use client";

import { useEffect, useState } from "react";

import type { InventoryPurchaseOrderLine } from "@rop/contracts";

import { fetchPo, receivePo, writeFailureReason, type WriteFailure } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useCrewData } from "@/lib/crew-data";
import { useIdempotencyKey } from "@/lib/use-idempotency-key";
import { ITEM_GLYPHS } from "@/lib/employees";
import { FlowSuccess } from "./flow-success";
import { STRINGS, writeFailureKey } from "@/lib/strings";
import type { Lang } from "@/lib/types";
import { useCrewSize } from "@/lib/use-crew-size";

type LineState = "ok" | "short";

// Recibir (design handoff §5) — single screen: PO chips switch open orders, each
// line is marked OK or Falta (Falta reveals a received-qty input), then Confirmar
// recepción commits via the existing idempotent PO receive. Top-bar back → home.
export function ReceiveFlow({
  lang,
  onDone,
  onChanged,
}: {
  lang: Lang;
  onDone: () => void;
  onChanged?: () => void | Promise<void>;
}) {
  const T = STRINGS[lang];
  const phone = useCrewSize().kind === "phone";
  const { pos, items } = useCrewData();
  const open = pos.filter((p) => p.status === "in-transit" || p.status === "submitted");

  const [poId, setPoId] = useState<string | null>(open[0]?.id ?? null);
  // Fetched lines are tagged with the PO they belong to and derived below, so the
  // effect never has to synchronously reset state (which the cascading-render lint
  // forbids) — checks/shortQty reset happens in the chip click handler instead.
  const [loaded, setLoaded] = useState<{ poId: string; lines: InventoryPurchaseOrderLine[] } | null>(null);
  const [checks, setChecks] = useState<Record<string, LineState | undefined>>({});
  const [shortQty, setShortQty] = useState<Record<string, string>>({});
  // Per-line pack selection for the SHORT (partial) received qty (ADR-0737). null/absent =
  // base unit; a pack id means the entered number counts packs and the API multiplies.
  const [linePack, setLinePack] = useState<Record<string, string | null>>({});
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<WriteFailure | null>(null);
  const { keyFor } = useIdempotencyKey();

  useEffect(() => {
    if (!poId) return;
    let active = true;
    fetchPo(poId)
      .then((detail) => {
        if (active) setLoaded({ poId, lines: detail.line_items });
      })
      .catch(() => {
        if (active) setError("server");
      });
    return () => {
      active = false;
    };
  }, [poId]);

  const selectPo = (id: string) => {
    setPoId(id);
    setChecks({});
    setShortQty({});
    setLinePack({});
  };
  const lines = loaded?.poId === poId ? loaded.lines : [];

  if (done) {
    return <FlowSuccess title={T.rcv_done} sub={T.rcv_updated} doneLabel={T.done} onDone={onDone} />;
  }

  const po = open.find((p) => p.id === poId);
  if (!po) {
    return (
      <div className="h-full bg-zinc-50 flex items-center justify-center">
        <div className="text-zinc-400 text-base">{T.rcv_none}</div>
      </div>
    );
  }

  const allDone = lines.length > 0 && lines.every((l) => checks[l.sku]);
  const okCount = lines.filter((l) => checks[l.sku]).length;
  const errText = error ? T[writeFailureKey(error)] : null;

  const submit = async () => {
    if (!allDone || busy) return;
    setBusy(true);
    setError(null);
    try {
      const payload = lines.map((l) => {
        if (checks[l.sku] !== "short") {
          return { sku: l.sku, qty: l.qty_ordered };
        }
        const qty = Number(shortQty[l.sku] ?? l.qty_ordered) || 0;
        const packId = linePack[l.sku];
        return packId ? { sku: l.sku, qty, pack_id: packId } : { sku: l.sku, qty };
      });
      // Re-tap on the same PO with the same OK/short marks reuses the key; changing a
      // received qty (or the PO) mints a fresh one (see useIdempotencyKey).
      const key = keyFor(`${po.id}|${JSON.stringify(payload)}`);
      await receivePo(po.id, payload, key);
      await onChanged?.();
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
          {T.rcv_title}
        </h2>
        <p className={cn("text-zinc-500 mt-1", phone ? "text-sm" : "text-base")}>{T.rcv_sub}</p>
      </div>

      <div className={cn("flex gap-2.5 flex-wrap pt-2.5", phone ? "px-4" : "px-10")}>
        {open.map((p) => (
          <button
            key={p.id}
            onClick={() => selectPo(p.id)}
            className={cn(
              "text-left px-4 py-3 rounded-2xl bg-white border min-w-[200px]",
              p.id === poId ? "border-zinc-900 ring-1 ring-zinc-900" : "border-zinc-200",
            )}
          >
            <span className="block font-semibold text-base">{p.vendor}</span>
            <span className="block font-mono text-xs text-zinc-500 mt-0.5">
              {p.id} · {p.lines} {T.receive_lines}
              {p.status === "in-transit" ? ` · ${T.rcv_intransit}` : ""}
            </span>
          </button>
        ))}
      </div>

      <div className={cn("flex items-center pt-3.5", phone ? "px-4" : "px-10")}>
        <span className="font-mono text-sm text-zinc-500">
          {T.rcv_expected}: {po.expected.slice(5)}
        </span>
        <span className="flex-1" />
        <button
          onClick={() => {
            const next: Record<string, LineState> = {};
            lines.forEach((l) => (next[l.sku] = "ok"));
            setChecks(next);
          }}
          className="h-11 px-4 rounded-[14px] bg-zinc-900 text-white font-medium text-sm"
        >
          ✓ {T.rcv_checkall}
        </button>
      </div>

      <div className={cn("flex-1 overflow-y-auto flex flex-col gap-2.5 pt-3", phone ? "px-4 pb-3" : "px-10 pb-3")}>
        {lines.map((l) => {
          const st = checks[l.sku];
          const itemPacks = items.find((it) => it.id === l.sku)?.packs ?? [];
          const linePackObj = itemPacks.find((p) => p.id === linePack[l.sku]) ?? null;
          return (
            <div key={l.sku} data-testid={`rcv-line-${l.sku}`} className="bg-white border border-zinc-200 rounded-[18px] p-3.5">
              <div className="flex items-center gap-4 flex-wrap">
                <div className="rounded-2xl bg-zinc-100 flex items-center justify-center flex-none size-14 text-2xl">
                  {ITEM_GLYPHS[l.sku] ?? "📦"}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[17px] font-semibold text-zinc-900 truncate">{l.name}</div>
                  <div className="font-mono text-xs text-zinc-400 mt-0.5 tabular-nums">
                    {l.qty_ordered} {l.unit}
                  </div>
                </div>
                <div className={cn("flex gap-2 flex-none", phone && "w-full")}>
                  <button
                    onClick={() => setChecks((c) => ({ ...c, [l.sku]: c[l.sku] === "ok" ? undefined : "ok" }))}
                    className={cn(
                      "h-13 px-4.5 rounded-[14px] font-semibold text-[15px]",
                      phone && "flex-1",
                      st === "ok" ? "text-white" : "bg-zinc-100 text-zinc-600",
                    )}
                    style={st === "ok" ? { background: "#1F8A5B", height: 52 } : { height: 52 }}
                  >
                    {st === "ok" ? "✓" : "○"} {T.rcv_ok}
                  </button>
                  <button
                    onClick={() => {
                      setChecks((c) => ({ ...c, [l.sku]: c[l.sku] === "short" ? undefined : "short" }));
                      setShortQty((s) => (s[l.sku] === undefined ? { ...s, [l.sku]: String(l.qty_ordered) } : s));
                    }}
                    className={cn(
                      "h-13 px-4.5 rounded-[14px] font-semibold text-[15px]",
                      phone && "flex-1",
                      st === "short" ? "text-white" : "bg-zinc-100 text-zinc-600",
                    )}
                    style={st === "short" ? { background: "#c2410c", height: 52 } : { height: 52 }}
                  >
                    ⚠ {T.rcv_short}
                  </button>
                </div>
              </div>
              {st === "short" && (
                <div className={cn("mt-3", phone ? "" : "pl-[72px]")}>
                  {itemPacks.length > 0 && (
                    <div className="flex items-center gap-2 overflow-x-auto pb-2">
                      <button
                        onClick={() => setLinePack((p) => ({ ...p, [l.sku]: null }))}
                        className={cn(
                          "h-9 px-3 rounded-lg text-sm font-medium whitespace-nowrap",
                          !linePack[l.sku] ? "bg-emerald-600 text-white" : "bg-zinc-100 text-zinc-600",
                        )}
                      >
                        {T.pack_by_unit}
                      </button>
                      {itemPacks.map((pk) => (
                        <button
                          key={pk.id}
                          onClick={() => setLinePack((p) => ({ ...p, [l.sku]: pk.id }))}
                          className={cn(
                            "h-9 px-3 rounded-lg text-sm font-medium whitespace-nowrap",
                            linePack[l.sku] === pk.id ? "bg-emerald-600 text-white" : "bg-zinc-100 text-zinc-600",
                          )}
                        >
                          {pk.label}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="flex items-center gap-2.5">
                    <span className="text-zinc-500 text-sm">{T.rcv_received}:</span>
                    <input
                      type="number"
                      inputMode="numeric"
                      value={shortQty[l.sku] ?? ""}
                      onChange={(e) => setShortQty((s) => ({ ...s, [l.sku]: e.target.value }))}
                      className="w-28 h-12 rounded-[14px] border border-zinc-200 px-3.5 font-mono text-lg"
                    />
                    <span className="text-zinc-500 text-sm">
                      {linePackObj ? T.pack_count_unit : `/ ${l.qty_ordered} ${l.unit}`}
                    </span>
                  </div>
                  {linePackObj && Number(shortQty[l.sku]) > 0 && (
                    <div className="mt-2 font-mono text-[13px] text-zinc-500">
                      {Number(shortQty[l.sku])} × {linePackObj.label} ={" "}
                      {Number(shortQty[l.sku]) * linePackObj.base_qty_per_pack} {l.unit}
                    </div>
                  )}
                </div>
              )}
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
          onClick={submit}
          disabled={!allDone || busy}
          className="w-full h-16 rounded-2xl text-white font-semibold text-lg inline-flex items-center justify-center gap-2 disabled:bg-zinc-200 disabled:text-zinc-400"
          style={allDone && !busy ? { background: "#1F8A5B", boxShadow: "0 12px 30px -8px rgba(31,138,91,.45)" } : undefined}
        >
          ✓ {T.rcv_finish} ({okCount}/{lines.length})
        </button>
      </div>
    </div>
  );
}
