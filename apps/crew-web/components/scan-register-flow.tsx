"use client";

import { useEffect, useRef, useState } from "react";

import {
  addItem,
  lookupBarcodeEnrich,
  receiveAdHoc,
  saveBarcode,
  saveItemPack,
  writeFailureReason
} from "@/lib/api";
import { STRINGS, writeFailureKey } from "@/lib/strings";
import type { Lang } from "@/lib/types";
import { useIdempotencyKey } from "@/lib/use-idempotency-key";
import type {
  InventoryBarcodeEnrich,
  InventoryCategory,
  InventoryItem,
  InventoryUnitKind
} from "@rop/contracts";

import { BarcodeScanner } from "./barcode-scanner";

// Floor scan-to-register (barcode-onboarding ADR, D2 — opened to the floor per the owner). A cook
// scans a Sam's/Walmart UPC, the form pre-fills from the OFF public API, and on save the item is
// created + the barcode bound; the camera then re-arms for the next package (the rapid-fire haul
// loop). Registration parity with backoffice's ScanRegisterSheet, but crew-native (raw Tailwind,
// Spanish) and minus the manager-only vendor/price fields — those stay editable in Artículos.
//
// Server-side this needs no new auth: inventory writes are dual-auth (the crew session cookie is
// accepted), and the floor already authors items via "＋ Nuevo", so scanning crosses no new trust
// boundary — it just adds OFF auto-fill + barcode binding.

const INPUT =
  "w-full h-12 rounded-xl border border-zinc-200 px-3 text-base text-zinc-900 outline-none focus:border-zinc-400";
const SELECT = `${INPUT} appearance-none bg-white`;

export function ScanRegisterFlow({
  lang,
  categories,
  initialCode,
  onDone,
  onChanged
}: {
  lang: Lang;
  categories: InventoryCategory[];
  // A code already scanned upstream (the Escanear-código adjust flow hands off an unknown code
  // here when the cook chooses to register it). When set, we skip our own camera and resolve it
  // straight away, landing on the register form — no second scan.
  initialCode?: string | null;
  // Close the flow → back to Artículos (the × on any stage, or the camera cancel after a code).
  onDone: () => void;
  // Reload the shared dataset after a write so the catalog reflects the new item at once.
  onChanged?: () => void | Promise<void>;
}) {
  const T = STRINGS[lang];
  const firstCategory = categories[0]?.id ?? "";

  // Camera-first: open the scanner immediately (best for a haul) UNLESS we were seeded with a
  // code, in which case we go straight to lookup. Cancel drops to the manual "choose" screen
  // rather than closing the whole flow, so a denied camera still has a path in.
  const [scanning, setScanning] = useState(!initialCode);
  const [camKey, setCamKey] = useState(0);
  const [code, setCode] = useState<string | null>(null);
  const [manual, setManual] = useState("");

  const [enrich, setEnrich] = useState<InventoryBarcodeEnrich | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Review form.
  const [name, setName] = useState("");
  const [category, setCategory] = useState(firstCategory);
  const [unit, setUnit] = useState("");
  const [unitKind, setUnitKind] = useState<InventoryUnitKind>("count");
  const [packLabel, setPackLabel] = useState("");
  const [packQty, setPackQty] = useState("");

  // After a save: the receive-on-register step.
  const [savedItem, setSavedItem] = useState<InventoryItem | null>(null);
  const [recvQty, setRecvQty] = useState("");
  const [recvPackId, setRecvPackId] = useState("");
  const { keyFor, reset: resetKey } = useIdempotencyKey();

  function resetForm() {
    setName("");
    setCategory(firstCategory);
    setUnit("");
    setUnitKind("count");
    setPackLabel("");
    setPackQty("");
    setEnrich(null);
    setError(null);
  }

  // Loop back to the camera for the next package — the batch-haul behavior.
  function scanNext() {
    setCode(null);
    setManual("");
    setSavedItem(null);
    setRecvQty("");
    setRecvPackId("");
    resetForm();
    setCamKey((k) => k + 1);
    setScanning(true);
  }

  // Resolve a scanned/typed code: a registered hit short-circuits to "already"; otherwise the OFF
  // suggestions (fail-open → possibly null) pre-fill the review form once.
  async function lookup(raw: string) {
    const c = raw.trim();
    if (!c || busy) return;
    setScanning(false);
    setCode(c);
    setBusy(true);
    try {
      const e = await lookupBarcodeEnrich(c);
      setEnrich(e);
      if (!e.registered && e.suggestions) {
        setName(e.suggestions.name ?? "");
        if (e.suggestions.category) setCategory(e.suggestions.category);
        setUnit(e.suggestions.unit ?? "");
        setUnitKind(e.suggestions.unit_kind ?? "count");
      }
    } finally {
      setBusy(false);
    }
  }

  // Seeded entry (handed a code from the adjust scanner): resolve it once on mount so the cook
  // lands on the prefilled register form instead of a second camera. Guarded to fire exactly once.
  const didSeed = useRef(false);
  useEffect(() => {
    if (didSeed.current) return;
    didSeed.current = true;
    const seed = initialCode?.trim();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fire-and-forget; state updates after effect returns
    if (seed) void lookup(seed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const packQtyNum = parseFloat(packQty);
  const wantsPack = packLabel.trim() !== "" && Number.isFinite(packQtyNum) && packQtyNum > 0;
  const canRegister = name.trim() !== "" && category !== "" && unit.trim() !== "" && !busy;

  // create item (pack_qty inline) → optional pack row → bind the barcode (to the pack when made).
  async function register() {
    if (!code || !canRegister) return;
    setBusy(true);
    setError(null);
    try {
      const item = await addItem({
        name: name.trim(),
        category,
        unit: unit.trim(),
        unit_kind: unitKind,
        par_min: 0,
        par_max: 0,
        pack_qty: wantsPack ? packQtyNum : undefined
      });
      let packId: string | undefined;
      if (wantsPack) {
        const afterPack = await saveItemPack(item.id, {
          label: packLabel.trim(),
          base_qty_per_pack: packQtyNum,
          is_purchase_default: true
        });
        packId = afterPack.packs?.find((p) => p.label === packLabel.trim())?.id;
      }
      const saved = await saveBarcode(item.id, { code, pack_id: packId ?? null, source: "manufacturer" });
      await onChanged?.();
      setSavedItem(saved);
      setRecvPackId(packId ?? "");
    } catch (e) {
      setError(T[writeFailureKey(writeFailureReason(e))]);
    } finally {
      setBusy(false);
    }
  }

  const recvQtyNum = parseFloat(recvQty);
  const recvValid = Number.isFinite(recvQtyNum) && recvQtyNum > 0;

  // Book the delivered quantity for the just-saved item, then loop to the camera. A pack_id ⇒ qty
  // is in packs (API multiplies by base_qty_per_pack); absent ⇒ base units. Fresh idempotency key
  // per (item, qty, pack) so a re-tap dedups server-side.
  async function bookReceipt() {
    if (!savedItem || !recvValid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await receiveAdHoc(
        savedItem.vendor || undefined,
        [{ sku: savedItem.id, qty: recvQtyNum, pack_id: recvPackId || undefined }],
        keyFor(`${savedItem.id}|${recvQtyNum}|${recvPackId}`)
      );
      resetKey();
      scanNext();
    } catch (e) {
      setError(T[writeFailureKey(writeFailureReason(e))]);
      setBusy(false);
    }
  }

  if (scanning) {
    return (
      <BarcodeScanner key={camKey} lang={lang} onDetect={(c) => void lookup(c)} onClose={() => setScanning(false)} />
    );
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex flex-col bg-[#0a0a0a] text-white"
      role="dialog"
      aria-modal="true"
      aria-label={T.sr_title}
    >
      <div
        className="flex items-center justify-between px-5"
        style={{ paddingTop: "calc(1rem + env(safe-area-inset-top))", paddingBottom: "0.75rem" }}
      >
        <span className="text-[15px] font-semibold">{T.sr_title}</span>
        <button
          onClick={onDone}
          aria-label={T.cancel}
          className="flex size-10 items-center justify-center rounded-full bg-white/15 text-2xl leading-none"
        >
          ×
        </button>
      </div>

      <div className="flex flex-1 items-start justify-center overflow-y-auto px-5 pb-8">
        <div className="w-full max-w-md space-y-4 rounded-3xl bg-white p-5 text-zinc-900">
          {busy && !savedItem && !enrich ? (
            <p className="py-8 text-center text-sm text-zinc-500">
              {T.sr_searching} <span className="font-mono">{code}</span>
            </p>
          ) : savedItem ? (
            <>
              <div className="text-sm font-semibold" style={{ color: "#1F8A5B" }}>
                {T.sr_saved} {savedItem.name}
              </div>
              <p className="text-sm text-zinc-500">{T.sr_recv_q}</p>
              <div className="grid grid-cols-2 gap-3">
                <input
                  value={recvQty}
                  inputMode="decimal"
                  autoFocus
                  onChange={(e) => setRecvQty(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && recvValid && !busy) void bookReceipt();
                  }}
                  placeholder="0"
                  className={INPUT}
                  aria-label={T.sr_recv}
                />
                <select
                  value={recvPackId}
                  onChange={(e) => setRecvPackId(e.target.value)}
                  className={SELECT}
                  aria-label={T.sr_in}
                >
                  <option value="">{savedItem.unit}</option>
                  {(savedItem.packs ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label} ({p.base_qty_per_pack} {savedItem.unit})
                    </option>
                  ))}
                </select>
              </div>
              {error ? <p className="text-sm text-red-600">{error}</p> : null}
              <div className="flex gap-2">
                <button
                  onClick={scanNext}
                  disabled={busy}
                  className="h-12 flex-none rounded-2xl border border-zinc-200 px-5 font-semibold text-zinc-600 disabled:opacity-50"
                >
                  {T.sr_skip}
                </button>
                <button
                  onClick={() => void bookReceipt()}
                  disabled={!recvValid || busy}
                  className="h-12 flex-1 rounded-2xl font-semibold text-white disabled:bg-zinc-200 disabled:text-zinc-400"
                  style={recvValid && !busy ? { background: "#1F8A5B" } : undefined}
                >
                  {busy ? T.sr_saving : T.sr_recv}
                </button>
              </div>
            </>
          ) : code === null ? (
            <>
              <button
                onClick={() => setScanning(true)}
                className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl font-semibold text-white"
                style={{ background: "#0d9488" }}
              >
                {T.sr_scan_cta}
              </button>
              <div className="space-y-1">
                <label htmlFor="sr-manual" className="text-sm font-medium text-zinc-700">
                  {T.sr_manual}
                </label>
                <div className="flex gap-2">
                  <input
                    id="sr-manual"
                    value={manual}
                    inputMode="numeric"
                    onChange={(e) => setManual(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && manual.trim()) void lookup(manual.trim());
                    }}
                    placeholder="0123456789012"
                    className={`${INPUT} font-mono`}
                  />
                  <button
                    onClick={() => void lookup(manual.trim())}
                    disabled={!manual.trim()}
                    className="h-12 flex-none rounded-xl border border-zinc-200 px-4 font-semibold text-zinc-700 disabled:opacity-40"
                  >
                    {T.sr_lookup}
                  </button>
                </div>
              </div>
            </>
          ) : enrich?.registered ? (
            <>
              <div className="rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-3 text-sm">
                <div className="text-zinc-500">{T.sr_already}</div>
                <div className="mt-0.5 font-medium">{enrich.item?.name}</div>
                <div className="mt-0.5 font-mono text-xs text-zinc-400">{code}</div>
              </div>
              <button
                onClick={scanNext}
                className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl font-semibold text-white"
                style={{ background: "#0d9488" }}
              >
                {T.sr_scan_next}
              </button>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2 rounded-xl border border-zinc-200 px-3 py-2">
                <span className="font-mono text-sm">{code}</span>
                <span
                  className="ml-auto text-xs"
                  style={{ color: enrich?.suggestions ? "#1F8A5B" : "#a1a1aa" }}
                >
                  {enrich?.suggestions ? T.sr_found : T.sr_new}
                </span>
              </div>

              <div className="space-y-1">
                <label htmlFor="sr-name" className="text-sm font-medium text-zinc-700">
                  {T.sr_name}
                </label>
                <input id="sr-name" value={name} autoFocus onChange={(e) => setName(e.target.value)} maxLength={120} className={INPUT} />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label htmlFor="sr-cat" className="text-sm font-medium text-zinc-700">
                    {T.sr_category}
                  </label>
                  <select id="sr-cat" value={category} onChange={(e) => setCategory(e.target.value)} className={SELECT}>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <label htmlFor="sr-unit" className="text-sm font-medium text-zinc-700">
                    {T.sr_unit}
                  </label>
                  <input id="sr-unit" value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="each / oz / ml" maxLength={24} className={INPUT} />
                </div>
              </div>

              <div className="space-y-1">
                <label htmlFor="sr-kind" className="text-sm font-medium text-zinc-700">
                  {T.f_unit_kind}
                </label>
                <select
                  id="sr-kind"
                  value={unitKind}
                  onChange={(e) => setUnitKind(e.target.value as InventoryUnitKind)}
                  className={SELECT}
                >
                  <option value="count">{T.unit_kind_count}</option>
                  <option value="weight">{T.unit_kind_weight}</option>
                  <option value="volume">{T.unit_kind_volume}</option>
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label htmlFor="sr-pack" className="text-sm font-medium text-zinc-700">
                    {T.sr_pack}
                  </label>
                  <input id="sr-pack" value={packLabel} onChange={(e) => setPackLabel(e.target.value)} placeholder="Caja" maxLength={60} className={INPUT} />
                </div>
                <div className="space-y-1">
                  <label htmlFor="sr-packqty" className="text-sm font-medium text-zinc-700">
                    {T.sr_pack_qty}
                  </label>
                  <input
                    id="sr-packqty"
                    value={packQty}
                    inputMode="decimal"
                    onChange={(e) => setPackQty(e.target.value)}
                    placeholder="24"
                    className={INPUT}
                  />
                </div>
              </div>

              {error ? <p className="text-sm text-red-600">{error}</p> : null}

              <div className="flex gap-2 pt-1">
                <button
                  onClick={() => setCode(null)}
                  disabled={busy}
                  className="h-12 flex-none rounded-2xl border border-zinc-200 px-5 font-semibold text-zinc-600 disabled:opacity-50"
                >
                  {T.back}
                </button>
                <button
                  onClick={() => void register()}
                  disabled={!canRegister}
                  className="h-12 flex-1 rounded-2xl font-semibold text-white disabled:bg-zinc-200 disabled:text-zinc-400"
                  style={canRegister ? { background: "#1F8A5B" } : undefined}
                >
                  {busy ? T.sr_saving : T.sr_register}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
