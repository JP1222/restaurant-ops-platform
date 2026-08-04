"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";

import type { InventoryItem, InventoryReceiptParseResult } from "@rop/contracts";
import { applyMatchSuggestions, baseProductName, categoryFromText, convertForReceive, looksLikePackUnit, mergeReceiptLines, resolveScanPacks } from "@rop/contracts/match";

import {
  receiveAdHoc,
  resolveBarcode,
  saveItemCost,
  scanReceipt,
  suggestEmojis,
  suggestMatches,
  writeFailureReason,
  type AdHocReceiveLineInput,
  type WriteFailure,
} from "@/lib/api";
import { cn } from "@/lib/cn";
import { useCrewData } from "@/lib/crew-data";
import { money } from "@/lib/crew-status";
import { useIdempotencyKey } from "@/lib/use-idempotency-key";
import { resizeImageForUpload } from "@/lib/image";
import { renderPdfFirstPage } from "@/lib/pdf";
import { matchDescription, matchReceiptLines } from "@/lib/scan";
import { ItemThumb } from "./item-thumb";
import { BarcodeScanner } from "./barcode-scanner";
import { STRINGS, writeFailureKey } from "@/lib/strings";
import type { Lang } from "@/lib/types";
import { useCrewSize } from "@/lib/use-crew-size";

type Step = "capture" | "analyzing" | "review" | "success";
type Recap = { name: string; qty: number; unit: string };

// Escanear factura (design handoff §3). capture → AI analyze → human-review →
// import. The extraction is server-side (lib/api scanReceipt → BFF → backoffice Gemini
// vision, with a dev-only stub fallback); the description→item matching and the editable review are the
// product surface, and nothing writes to stock until the operator confirms (the
// "model proposes, human commits" boundary, ADR-0538 D4).
export function ScanFlow({
  lang,
  onDone,
  onChanged,
  registerBackGuard,
}: {
  lang: Lang;
  onDone: () => void;
  onChanged: () => Promise<void> | void;
  // Lets the review step intercept the top-bar back chevron while it holds
  // unsaved line edits (crew-app consults the registered guard before leaving).
  registerBackGuard?: (guard: (() => boolean) | null) => void;
}) {
  const T = STRINGS[lang];
  const phone = useCrewSize().kind === "phone";
  const { items } = useCrewData();

  const [step, setStep] = useState<Step>("capture");
  const [drag, setDrag] = useState(false);
  const [photo, setPhoto] = useState<string | null>(null);
  const [parse, setParse] = useState<InventoryReceiptParseResult | null>(null);
  const [imported, setImported] = useState<Recap[]>([]);
  const [error, setError] = useState<WriteFailure | null>(null);
  // Two separate inputs: the camera one carries `capture` (opens the camera on a
  // phone), the upload one does NOT (so "Subir archivo" opens the file picker, not
  // the camera) and accepts PDFs as well as images.
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Last prepared capture, so a timed-out analyze can "Reintentar" with the same
  // photo instead of sending the cook back to the camera.
  const lastCaptureRef = useRef<{ base64: string; mime: string } | null>(null);

  const analyze = async (base64: string, mime: string) => {
    setError(null);
    setStep("analyzing");
    try {
      // Hold the analyzing animation briefly so the scan reads as "AI is working",
      // not a flash — the stub returns near-instantly.
      const [result] = await Promise.all([
        scanReceipt(base64, mime),
        new Promise((r) => setTimeout(r, 1300)),
      ]);
      setParse(result);
      setStep("review");
    } catch (e) {
      setError(writeFailureReason(e));
      setStep("capture");
    }
  };

  const startFromFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    let base64: string;
    let mime: string;
    try {
      // A PDF invoice (emailed / scanned-to-PDF) can't be decoded by the canvas
      // image path, so render its first page to a JPEG first; images go straight
      // through the resizer. Either way the result is image/jpeg, so the scan
      // route + backoffice parse schema are unchanged.
      const resized =
        file.type === "application/pdf"
          ? await renderPdfFirstPage(file)
          : await resizeImageForUpload(file);
      base64 = resized.dataBase64;
      mime = resized.contentType;
      setPhoto(`data:${mime};base64,${base64}`);
    } catch {
      setError("server");
      return;
    }
    lastCaptureRef.current = { base64, mime };
    await analyze(base64, mime);
  };

  if (step === "capture") {
    return (
      <div className="h-full flex flex-col bg-zinc-50">
        <div className={cn(phone ? "px-4 pt-3.5" : "px-10 pt-4")}>
          <h2 className={cn("font-semibold tracking-tight text-zinc-900", phone ? "text-xl" : "text-3xl")}>
            {T.scan_hero}
          </h2>
        </div>
        <div className={cn("flex-1 flex items-center justify-center", phone ? "px-4 py-5" : "px-10 py-8")}>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              void startFromFile(e.dataTransfer.files?.[0]);
            }}
            className={cn(
              "w-full max-w-[760px] rounded-[28px] bg-white text-center border-[2.5px] border-dashed transition-colors",
              phone ? "px-5 py-9" : "px-10 py-12",
              drag ? "border-violet-500 bg-violet-50" : "border-zinc-300",
            )}
          >
            {/* Camera: `capture` opens the rear camera on a phone. */}
            <input
              ref={cameraInputRef}
              data-testid="scan-camera-input"
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(e) => void startFromFile(e.target.files?.[0])}
            />
            {/* Upload: NO `capture`, so the OS file picker opens (not the camera);
                accepts PDFs + images (the user's emailed/scanned invoices). */}
            <input
              ref={fileInputRef}
              data-testid="scan-file-input"
              type="file"
              accept="image/png,image/jpeg,image/webp,image/heic,application/pdf"
              className="hidden"
              onChange={(e) => void startFromFile(e.target.files?.[0])}
            />
            <div
              className="mx-auto mb-5 rounded-[28px] flex items-center justify-center text-white size-24"
              style={{ background: "linear-gradient(140deg,#6D5AE0,#5B8DEF)" }}
            >
              <CameraIcon className="size-12" />
            </div>
            <h3 className="text-[26px] font-semibold tracking-tight mb-2 text-zinc-900">{T.scan_cap_h}</h3>
            <p className="text-zinc-500 text-base mb-7 max-w-md mx-auto">{T.scan_cap_p}</p>
            <div className={cn("flex gap-3.5 justify-center", phone && "flex-col")}>
              <button
                type="button"
                onClick={() => cameraInputRef.current?.click()}
                className="inline-flex items-center justify-center gap-2.5 px-7 rounded-[18px] text-white font-semibold text-[17px] active:scale-[0.97] transition-transform"
                style={{ background: "#6D5AE0", boxShadow: "0 12px 26px -10px rgba(109,90,224,.6)", height: 60 }}
              >
                <CameraIcon className="size-[22px]" /> {T.scan_take}
              </button>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center justify-center gap-2.5 px-7 rounded-[18px] bg-white border border-zinc-200 text-zinc-600 font-semibold text-[17px] active:scale-[0.97] transition-transform"
                style={{ height: 60 }}
              >
                <UploadIcon className="size-[22px]" /> {T.scan_upload}
              </button>
            </div>
            <div className="mt-6 text-zinc-400 text-sm flex items-center justify-center gap-2">
              <SparkleIcon className="size-[15px]" style={{ color: "#6D5AE0" }} /> {T.scan_cap_hint}
            </div>
          </div>
        </div>
        {error && (
          <div className="px-10 pb-6 text-center text-sm text-red-600">
            <div>{T[writeFailureKey(error, "scan_error")]}</div>
            {/* A timeout always follows an analyze, so lastCaptureRef is set —
                the onClick guard alone suffices (refs aren't readable in render). */}
            {error === "timeout" && (
              <button
                type="button"
                onClick={() => {
                  const last = lastCaptureRef.current;
                  if (last) void analyze(last.base64, last.mime);
                }}
                className="mt-2.5 h-11 px-5 rounded-[14px] bg-zinc-900 text-white font-medium text-sm active:scale-[0.97] transition-transform"
              >
                {T.scan_retry}
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  if (step === "analyzing") {
    return (
      <div className="h-full flex flex-col items-center justify-center bg-zinc-50 gap-7 p-10">
        <div className="relative w-[280px] max-w-[70vw] rounded-[20px] overflow-hidden shadow-2xl">
          {photo ? (
            // eslint-disable-next-line @next/next/no-img-element -- local capture preview
            <img src={photo} alt="" className="w-full block" />
          ) : (
            <div className="w-full h-72 bg-zinc-200" />
          )}
          <div className="crew-scan-sweep absolute inset-x-0 top-0 h-2/5" />
        </div>
        <div className="flex items-center gap-3 text-xl font-semibold text-zinc-600">
          {T.scan_analyzing}
          <span className="inline-flex gap-1.5">
            <Dot /> <Dot delay="0.16s" /> <Dot delay="0.32s" />
          </span>
        </div>
        <div className="text-zinc-400 text-[15px]">{T.scan_analyzing_step}</div>
      </div>
    );
  }

  if (step === "review" && parse) {
    return (
      <ScanReview
        lang={lang}
        parse={parse}
        items={items}
        capture={lastCaptureRef}
        onCancel={() => setStep("capture")}
        onExit={onDone}
        registerBackGuard={registerBackGuard}
        onImported={async (recap) => {
          setImported(recap);
          await onChanged();
          setStep("success");
        }}
      />
    );
  }

  // success
  return (
    <div className="h-full flex flex-col items-center justify-center bg-zinc-50 p-10 text-center">
      <div
        className="rounded-full text-white flex items-center justify-center size-32"
        style={{ background: "#10b981", boxShadow: "0 20px 50px -12px rgba(16,185,129,.5)" }}
      >
        <CheckIcon className="size-16" strokeWidth={2.5} />
      </div>
      <h1 className="text-4xl font-semibold tracking-tight mt-7 text-zinc-900">{T.scan_succ_h}</h1>
      <p className="text-zinc-500 text-lg mt-2.5">
        {imported.length} {imported.length === 1 ? T.scan_succ_one : T.scan_succ_many}
      </p>
      <div className="flex gap-2.5 flex-wrap justify-center mt-5 max-w-2xl">
        {imported.map((u, i) => (
          <span
            key={i}
            className="inline-flex items-center gap-2 bg-white border border-zinc-200 rounded-[14px] px-3.5 py-2 text-sm font-medium"
          >
            <span className="size-2 rounded-full" style={{ background: "#1F8A5B" }} />
            {u.name} <b className="font-mono tabular-nums">+{u.qty} {u.unit}</b>
          </span>
        ))}
      </div>
      <button
        onClick={onDone}
        className="h-16 px-10 rounded-2xl text-white font-semibold text-lg mt-8 active:scale-95 transition-transform"
        style={{ background: "#18181b" }}
      >
        {T.done}
      </button>
    </div>
  );
}

interface Row {
  raw: string;
  qty: number;
  unit: string;
  priceCents: number;
  include: boolean;
  target: string; // item id or "__new__"
  applyPrice: boolean;
  niceName: string;
  cat: string;
  newUnit: string;
  vendor: string;
  par: string; // min par (optional)
  parMax: string; // max par / overstock ceiling (optional; "" or 0 = no ceiling)
  brand: string; // AI-extracted, learned onto the alias (not the item name)
  pack: string;
  fromMemory: boolean; // matched via a learned alias
  aiConfidence?: number; // set when the AI semantic-match tier resolved this line (0..1)
  icon: string; // AI-suggested emoji for a NEW line; applied at inline-create, "" = none
  // Operator-confirmed "received as a pack" (ADR-0592): when on (and the matched item has a
  // real pack), the printed pack qty/price convert to the item's stock unit + per-unit cost
  // before receive. Defaults from the invoice unit vs the item's purchase unit.
  asPack: boolean;
  // ADR-882 Phase 4 — same-product-different-size grouping. When `itemGroup` is set, this line is
  // one size of a multi-size NEW item: it shares the group ref so the receive creates ONE item with
  // many packs (ADR-0737). `packLabel`/`packBaseQty` describe this size's pack (base_qty is in the
  // item's `newUnit` base, cross-unit-converted from the printed size); empty `packBaseQty` =
  // operator still needs to enter it (`needsPackInput`). A line MAPPED to an existing item that
  // also carries a packLabel adds that size as a new pack of it. Lone/plain lines leave these blank.
  itemGroup: string; // "" = not grouped
  packLabel: string; // "" = no pack (flat item / receive into base unit)
  packBaseQty: string; // base units per pack, in `newUnit`; "" = unset
  needsPackInput: boolean; // grouped/new-pack line whose size couldn't be auto-converted
}

function ScanReview({
  lang,
  parse,
  items,
  capture,
  onCancel,
  onExit,
  registerBackGuard,
  onImported,
}: {
  lang: Lang;
  parse: InventoryReceiptParseResult;
  items: InventoryItem[];
  // The parent's capture ref (base64 + mime) to archive with the receive (receipt-archive).
  // Passed as the ref OBJECT (not .current) so we read it in the confirm handler, never
  // during render (react-hooks/refs). null current only if review was reached without a
  // capture (shouldn't happen in the normal flow). Archiving is best-effort server-side.
  capture: RefObject<{ base64: string; mime: string } | null>;
  onCancel: () => void;
  onExit: () => void;
  registerBackGuard?: (guard: (() => boolean) | null) => void;
  onImported: (recap: Recap[]) => Promise<void>;
}) {
  const T = STRINGS[lang];
  const phone = useCrewSize().kind === "phone";
  const { categories, aliases } = useCrewData();

  // Collapse duplicate lines that resolve to the SAME catalog item (same unit + price) into one
  // row with summed qty, before review (conservative merge — ADR-0538 D4). matchDescription is the
  // deterministic resolver; a price/unit difference keeps the line a separate, visible row. Folded
  // here so the rows init AND the once-on-mount AI tiers below all read the same merged line list.
  const mergedParse = useMemo(
    () => ({
      ...parse,
      lines: mergeReceiptLines(
        parse.lines,
        parse.lines.map((l) =>
          matchDescription(l.description, items, aliases, parse.vendor, l.canonical_name),
        ),
      ).lines,
    }),
    [parse, items, aliases],
  );

  const [rows, setRows] = useState<Row[]>(() => {
    const matchedLines = matchReceiptLines(mergedParse, items, aliases);
    // ADR-882 Phase 4: collapse same-product-different-size lines into ONE item with many packs.
    // resolveScanPacks suggests a family group (or a new pack of an existing item) + the pack's
    // base_qty cross-unit-converted into the item's base unit. An editable, operator-confirmed
    // default (ADR-0538 D4) — the "split" control below ungroups a row.
    const packPlan = resolveScanPacks(
      matchedLines.map((m, index) => ({
        index,
        matchId: m.matchId,
        canonicalName: m.canonicalName,
        description: m.raw,
      })),
      items.map((it) => ({ id: it.id, name: it.name, unit: it.unit })),
    );
    return matchedLines.map((m, index) => {
      const matched = m.matchId ? items.find((it) => it.id === m.matchId) : undefined;
      const rp = packPlan[index];
      // Phase 4 (crew) wires the FAMILY case only — >=2 new lines that are one product at different
      // sizes become ONE new item with many packs (the screenshot scenario), rendered as new-item
      // rows. The new-size-of-an-EXISTING-item suggestion (rp.targetItemId) is deferred: it renders
      // as a matched row, which has no pack editor yet. So a non-family line stays flat as before.
      const target = m.matchId ?? "__new__";
      const itemGroup = rp?.itemGroup ?? "";
      // A NEW family item is created in the family's resolved base unit (e.g. "oz"); else the line's.
      const newUnit = (itemGroup && rp?.baseUnit) || m.unit;
      return {
      raw: m.raw,
      qty: m.qty,
      unit: m.unit,
      priceCents: m.priceCents,
      include: true,
      target,
      applyPrice: true,
      // Prefill a new item with the model's CLEAN canonical name (brand/pack stripped,
      // ADR-0586 D4), else a prettified raw line; the raw stays as the alias. A family member is
      // named by its BASE product (size stripped) so the shared item isn't named after one size.
      niceName: itemGroup
        ? baseProductName(m.canonicalName || prettify(m.raw))
        : m.canonicalName || prettify(m.raw),
      // A new line's category: the matched item's, else a deterministic guess from the name
      // (frozen-dessert-aware — candy/syrup -> topping), else "Other Food". NEVER categories[0]
      // ("Dairy & Cream"), which silently mis-filed every unmatched scan (ADR scan-multi-size D6).
      cat: matched?.category ?? categoryFromText(m.canonicalName || m.raw) ?? "food",
      newUnit,
      vendor: mergedParse.vendor ?? "",
      par: "",
      parMax: "",
      brand: m.brand,
      pack: m.pack,
      fromMemory: m.fromMemory,
      asPack: Boolean(matched && matched.pack_qty > 1 && looksLikePackUnit(m.unit, matched.purchase_unit)),
      icon: "",
      itemGroup,
      packLabel: itemGroup ? rp?.pack?.label ?? "" : "",
      packBaseQty: itemGroup && rp?.pack ? String(rp.pack.baseQtyPerPack) : "",
      needsPackInput: itemGroup ? rp?.needsPackInput ?? false : false,
      };
    });
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<WriteFailure | null>(null);
  // ScanReview unmounts on success (parent flips to the "success" step), so the next
  // scan gets a fresh ref — no reset() needed here.
  const { keyFor } = useIdempotencyKey();
  // Unsaved-edits guard (2026-06-12 audit P1): minutes of line-by-line invoice
  // edits shouldn't vanish on an accidental back. `dirty` flips only on a cook
  // edit — every manual change funnels through set() / the check-all button,
  // while the AI assist tiers below write via setRows directly, so an auto
  // suggestion alone never triggers the confirm. `leaving` remembers which
  // exit asked (top-bar chevron → leave the flow; Cancelar → back to capture).
  const [dirty, setDirty] = useState(false);
  const [leaving, setLeaving] = useState<"capture" | "exit" | null>(null);
  // Barcode scan to identify an unmatched line (ADR-0737): `scanRow` is the row whose
  // camera is open (null = closed); `scanMiss` notes a row+code that didn't resolve.
  const [scanRow, setScanRow] = useState<number | null>(null);
  const [scanMiss, setScanMiss] = useState<{ row: number; code: string } | null>(null);

  const set = (i: number, patch: Partial<Row>) => {
    setDirty(true);
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };
  const itemFor = (r: Row) => (r.target === "__new__" ? null : items.find((it) => it.id === r.target) ?? null);

  // Resolve a scanned barcode to a catalog item and map the row to it — the same effect as
  // picking it from the "Asignar a" dropdown (incl. the asPack derivation). An unknown code
  // or an off-catalog item leaves the row untouched and surfaces an inline note.
  const applyScannedCode = async (rowIndex: number, code: string) => {
    const current = rows[rowIndex];
    if (!current) return;
    try {
      const res = await resolveBarcode(code);
      const picked = res ? items.find((c) => c.id === res.item.id) : undefined;
      if (!picked) {
        setScanMiss({ row: rowIndex, code });
        return;
      }
      set(rowIndex, {
        target: picked.id,
        aiConfidence: undefined,
        asPack: Boolean(picked.pack_qty > 1 && looksLikePackUnit(current.unit, picked.purchase_unit)),
      });
      setScanMiss(null);
    } catch {
      setScanMiss({ row: rowIndex, code });
    }
  };

  useEffect(() => {
    if (!registerBackGuard) return;
    registerBackGuard(() => {
      if (!dirty) return false;
      setLeaving("exit");
      return true;
    });
    return () => registerBackGuard(null);
  }, [registerBackGuard, dirty]);

  // Best-effort companion for the browser-level exits (reload, tab close) the
  // in-app guard can't see.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // AI semantic-match tier (ADR-0587): once, on mount, ask the model to resolve the lines
  // the deterministic matcher left as new-SKU. Best-effort — suggestMatches never throws,
  // and only accepted (>= threshold, real-item) suggestions are applied, so a disabled /
  // unconfigured AI just leaves the deterministic result. Runs only when there's a residual.
  useEffect(() => {
    const initial = matchReceiptLines(mergedParse, items, aliases);
    const residual = initial
      .map((m, index) => ({ index, text: (m.canonicalName || m.raw).trim() }))
      .filter((l) => initial[l.index]?.matchId == null && l.text.length > 0);
    if (residual.length === 0) return;
    let cancelled = false;
    void (async () => {
      const { suggestions, threshold } = await suggestMatches(
        residual,
        items.map((it) => ({ id: it.id, name: it.name })),
      );
      if (cancelled) return;
      const accepted = applyMatchSuggestions(suggestions, new Set(items.map((it) => it.id)), threshold);
      if (accepted.size === 0) return;
      setRows((rs) =>
        rs.map((r, index) => {
          const hit = accepted.get(index);
          // Only upgrade a still-new line; never override a row the cook already edited.
          if (!hit || r.target !== "__new__") return r;
          const picked = items.find((it) => it.id === hit.itemId);
          const asPack = Boolean(picked && picked.pack_qty > 1 && looksLikePackUnit(r.unit, picked.purchase_unit));
          // The AI matched this line to a real item, so it's no longer a NEW family member —
          // drop any size-grouping the deterministic pass had suggested (ADR-882) and receive it
          // into the matched item normally.
          return { ...r, target: hit.itemId, aiConfidence: hit.confidence, asPack, itemGroup: "", packLabel: "", packBaseQty: "", needsPackInput: false };
        }),
      );
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once for this parse result
  }, []);

  // AI emoji-icon tier: once, on mount, ask the model for an emoji per NEW-SKU line so a
  // freshly-created item lands with an icon instead of the bare 📦 fallback (the same
  // "milk → 🥛" assist the catalog editor gives). Best-effort + cosmetic: suggestEmojis never
  // throws, only still-new icon-less rows are decorated, and a matched line ignores its icon
  // at confirm — so a disabled / unconfigured AI just leaves the category-glyph fallback.
  useEffect(() => {
    const initial = matchReceiptLines(mergedParse, items, aliases);
    const newLines = initial
      .map((m, index) => ({ index, name: (m.canonicalName || prettify(m.raw)).trim() }))
      .filter((l) => initial[l.index]?.matchId == null && l.name.length > 0);
    if (newLines.length === 0) return;
    let cancelled = false;
    void (async () => {
      const map = await suggestEmojis(newLines);
      if (cancelled || map.size === 0) return;
      setRows((rs) =>
        rs.map((r, index) => {
          const glyph = map.get(index);
          // Only decorate a still-new, icon-less line; never touch a matched/edited row.
          if (!glyph || r.target !== "__new__" || r.icon) return r;
          return { ...r, icon: glyph };
        }),
      );
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once for this parse result
  }, []);

  const active = rows.filter((r) => r.include);
  const total = useMemo(
    () => active.reduce((sum, r) => sum + Math.round(r.priceCents) * r.qty, 0),
    [active],
  );

  const confirm = async () => {
    if (busy || !active.length) return;
    setBusy(true);
    setError(null);
    // ADR-882: a row books a new_pack (size) when it has a pack label + a positive base qty (in the
    // item's base unit). Then `qty` is a number of THOSE packs and the server multiplies by base_qty.
    const packOf = (r: Row) =>
      r.packLabel.trim() !== "" && Number(r.packBaseQty) > 0
        ? { label: r.packLabel.trim(), base_qty_per_pack: Number(r.packBaseQty) }
        : null;
    try {
      const lines: AdHocReceiveLineInput[] = active.map((r) => {
        const it = itemFor(r);
        // Raw printed text + AI brand/pack ride along so the receive learns this vendor's
        // wording for the item (ADR-0586 D2), for matched AND new lines.
        const alias = { description: r.raw, brand: r.brand || undefined, pack: r.pack || undefined };
        const newPack = packOf(r);
        // A new_pack line books `qty` packs (server multiplies by base_qty), so the legacy
        // asPack/convertForReceive conversion must NOT also run — that would double-convert.
        // Operator-confirmed pack receive (ADR-0592): convert "2 cases @ $50" → stock-unit qty +
        // per-unit cost before it hits the receive (asPack only on for a matched pack_qty>1 item).
        const { qty, unitCostCents } = newPack
          ? { qty: r.qty, unitCostCents: r.priceCents }
          : convertForReceive(r.qty, r.priceCents, it?.pack_qty ?? 1, r.asPack);
        if (it) {
          // Matched/mapped to an existing item; a new_pack adds this size as a pack of it (ADR-882).
          return {
            sku: it.id,
            qty,
            unit_cost_cents: r.applyPrice ? unitCostCents : undefined,
            ...(newPack ? { new_pack: newPack } : {}),
            ...alias,
          };
        }
        // A NEW item. `item_group` ties same-product different-size lines into ONE item with many
        // packs (ADR-882); `new_pack` is this size. Optional par from the new-item fields — empty
        // stays undefined ("not set"); the API clamps a positive max below the min to 0.
        return {
          name: r.niceName.trim() || r.raw,
          category: r.cat,
          unit: (r.newUnit || r.unit || "each").trim(),
          qty,
          unit_cost_cents: unitCostCents,
          icon: r.icon || undefined,
          par_min: optInt(r.par),
          par_max: optInt(r.parMax),
          ...(r.itemGroup ? { item_group: r.itemGroup } : {}),
          ...(newPack ? { new_pack: newPack } : {}),
          ...alias,
        };
      });
      // The receive is the one stock-moving write here, so it carries the idempotency
      // key: a re-tap of "Importar" after a failed/lost response reuses it (the per-line
      // `adhoc:<key>:<item>` source_ref dedups), while editing any line (qty, mapping,
      // include, pack toggle, price) re-keys so the new set isn't masked. The reprice
      // loop below is naturally idempotent (it sets a cost), so it needs no key.
      const key = keyFor(`${mergedParse.vendor ?? ""}|${JSON.stringify(lines)}`);
      // Archive the scanned image with this receive (receipt-archive). Best-effort
      // server-side, so a missing/failed image never blocks the receive. The image is
      // NOT part of the idempotency key (a re-tap reuses the same key + overwrites the
      // same R2 object); editing a line re-keys the receive as before. Read the ref's
      // current value here (event handler), never during render.
      const cap = capture.current;
      await receiveAdHoc(
        mergedParse.vendor,
        lines,
        key,
        cap
          ? { imageBase64: cap.base64, contentType: cap.mime, invoiceDate: mergedParse.invoice_date }
          : undefined,
      );
      // Existing matched lines: the ad-hoc receive only moved on_hand, so apply the price
      // change with a separate item cost write where "Actualizar precio" is on. The per-usage
      // cost (cost_cents) is a FLOAT in this system (a napkin is 0.6c), so for a pack receive
      // divide the pack price WITHOUT rounding and let saveItemCost (cost-preserving) rebuild
      // the exact whole-cent pack price: a 6000-ct napkin case at $28.75 lands 0.479c/napkin,
      // not 0. Compare on the raw (sub-cent) values so a real change isn't hidden by rounding.
      for (const r of active) {
        const it = itemFor(r);
        // Skip new_pack lines: their price is per-pack, not the item's per-base cost — the receive
        // already converted + learned it. Repricing here would write a per-pack price as per-base.
        if (!it || !r.applyPrice || packOf(r)) continue;
        const repriceCostCents = r.asPack && it.pack_qty > 1 ? r.priceCents / it.pack_qty : r.priceCents;
        if (Math.abs(it.cost_cents - repriceCostCents) >= 0.005) {
          await saveItemCost(it.id, repriceCostCents, it.pack_qty);
        }
      }
      const recap: Recap[] = active.map((r) => {
        const it = itemFor(r);
        const newPack = packOf(r);
        // A new_pack line booked qty packs -> qty * base_qty base units; else the legacy conversion.
        const qty = newPack
          ? r.qty * newPack.base_qty_per_pack
          : convertForReceive(r.qty, r.priceCents, it?.pack_qty ?? 1, r.asPack).qty;
        return { name: it ? it.name : r.niceName.trim() || r.raw, qty, unit: it ? it.unit : r.newUnit || r.unit };
      });
      await onImported(recap);
    } catch (e) {
      setError(writeFailureReason(e));
      setBusy(false);
    }
  };

  return (
    <div className="relative h-full flex flex-col bg-zinc-50">
      <div className={cn("flex items-start gap-3.5", phone ? "px-4 pt-3.5" : "px-10 pt-4")}>
        <div className="flex-1 min-w-0">
          <h2 className={cn("font-semibold tracking-tight text-zinc-900", phone ? "text-xl" : "text-3xl")}>
            {mergedParse.vendor ?? T.scan_hero}
          </h2>
          <p className={cn("text-zinc-500 mt-1.5", phone ? "text-sm" : "text-base")}>{T.scan_review_p}</p>
        </div>
      </div>

      <div className={cn("flex items-center gap-3.5 flex-wrap", phone ? "px-4 py-3" : "px-10 py-3.5")}>
        <span
          className="inline-flex items-center gap-2 h-9 px-4 rounded-full font-semibold text-sm"
          style={{ background: "#f3f1fd", color: "#5B4BD0" }}
        >
          <SparkleIcon className="size-4" /> {active.length} {T.scan_recognized}
        </span>
        <span className="font-mono text-sm text-zinc-500 tabular-nums">{money(total)}</span>
        <span className="flex-1" />
        <button
          onClick={() => {
            setDirty(true);
            setRows((rs) => rs.map((r) => ({ ...r, include: true })));
          }}
          className="h-11 px-4 rounded-[14px] bg-zinc-900 text-white font-medium text-sm"
        >
          ✓ {T.scan_check_all}
        </button>
      </div>

      <div
        className={cn(
          "flex-1 overflow-y-auto overflow-x-hidden flex flex-col gap-2.5 pt-1",
          phone ? "px-4 pb-3" : "px-10 pb-3",
        )}
      >
        {rows.map((row, i) => {
          const it = itemFor(row);
          const isNew = row.target === "__new__";
          // After any operator-confirmed pack conversion (ADR-0592), so the on-hand preview and
          // the price-change chip reflect what actually commits (stock-unit qty + per-unit cost).
          const conv = convertForReceive(row.qty, row.priceCents, it?.pack_qty ?? 1, row.asPack);
          const effCost = conv.unitCostCents ?? row.priceCents;
          const after = it ? it.on_hand + conv.qty : conv.qty;
          const unit = it ? it.unit : row.unit;
          const priceChanged = it ? Math.round(it.cost_cents) !== Math.round(effCost) : false;
          const pct = priceChanged && it ? Math.round(((effCost - it.cost_cents) / it.cost_cents) * 100) : 0;
          return (
            <div
              key={i}
              className={cn(
                "rounded-[20px] border p-3.5 transition-opacity",
                row.include ? "" : "opacity-45",
                isNew ? "border-amber-200" : "border-zinc-200 bg-white",
              )}
              style={isNew ? { background: "#fdf8ec", borderColor: "#e6cf9a" } : undefined}
            >
              {/* On a phone the controls (qty stepper + include toggle) drop to a
                  second row so the identity (thumb + name + badge) gets the full
                  width — otherwise the fixed-width row overflows a narrow phone
                  (<~383px) and the whole list pans sideways. iPad/desktop keep one row. */}
              <div className={cn("flex gap-3", phone ? "flex-col" : "items-center gap-4")}>
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  {it ? (
                    <ItemThumb item={it} className="size-15 text-[28px] flex-none" rounded="rounded-2xl" />
                  ) : (
                    <div className="rounded-2xl bg-zinc-100 flex items-center justify-center flex-none size-15 text-[28px]">
                      {row.icon || "📦"}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-[18px] font-semibold text-zinc-900 flex items-center gap-2">
                      <span className="truncate">{it ? it.name : row.niceName}</span>
                      {isNew && (
                        <span
                          className="text-[11px] font-bold tracking-wide rounded px-2 py-0.5 whitespace-nowrap flex-none"
                          style={{ color: "#9a7515", background: "#f5e6b8" }}
                        >
                          {T.scan_new_sku}
                        </span>
                      )}
                      {!isNew && row.fromMemory && (
                        <span
                          className="text-[11px] font-bold tracking-wide rounded px-2 py-0.5 whitespace-nowrap flex-none inline-flex items-center gap-1"
                          style={{ color: "#5B4BD0", background: "#f3f1fd" }}
                        >
                          <SparkleIcon className="size-3" /> {T.scan_remembered}
                        </span>
                      )}
                      {!isNew && !row.fromMemory && row.aiConfidence != null && (
                        <span
                          className="text-[11px] font-bold tracking-wide rounded px-2 py-0.5 whitespace-nowrap flex-none inline-flex items-center gap-1"
                          style={{ color: "#5B4BD0", background: "#f3f1fd" }}
                        >
                          <SparkleIcon className="size-3" /> {T.scan_ai} {Math.round(row.aiConfidence * 100)}%
                        </span>
                      )}
                    </div>
                    <div className="font-mono text-xs text-zinc-400 mt-0.5 truncate">
                      “{row.raw}” · {money(row.priceCents)}/{row.unit}
                    </div>
                    {!isNew && (
                      <div className="font-mono text-[13px] text-zinc-500 mt-0.5 tabular-nums">
                        {it?.on_hand} → <b className="text-emerald-700">{after}</b> {unit} {T.scan_onhand}
                      </div>
                    )}
                    {!isNew && it && it.pack_qty > 1 && (
                      <button
                        type="button"
                        onClick={() => set(i, { asPack: !row.asPack })}
                        className="mt-1.5 inline-flex items-center gap-2 text-[13px] text-zinc-600"
                      >
                        <span
                          className={cn(
                            "size-5 rounded-md border-2 flex items-center justify-center flex-none",
                            row.asPack ? "text-white" : "bg-white border-zinc-300",
                          )}
                          style={row.asPack ? { background: "#5B4BD0", borderColor: "#5B4BD0" } : undefined}
                        >
                          {row.asPack && <CheckIcon className="size-3.5" strokeWidth={3} />}
                        </span>
                        <span className="tabular-nums">
                          {T.scan_by_pack} {it.purchase_unit.trim() || T.scan_pack} (×{it.pack_qty})
                          {row.asPack && conv.unitCostCents != null
                            ? ` · ${money(conv.unitCostCents)}/${it.unit}`
                            : ""}
                        </span>
                      </button>
                    )}
                  </div>
                </div>
                <div className={cn("flex items-center gap-2 flex-none", phone && "justify-end")}>
                  <Stepper
                    qty={row.qty}
                    unit={row.unit}
                    onDec={() => set(i, { qty: Math.max(0, row.qty - 1) })}
                    onInc={() => set(i, { qty: row.qty + 1 })}
                    onSet={(v) => set(i, { qty: v })}
                  />
                  <button
                    onClick={() => set(i, { include: !row.include })}
                    aria-label="toggle"
                    className={cn(
                      "rounded-xl border-2 flex items-center justify-center flex-none size-12",
                      row.include ? "text-white" : "bg-white text-transparent border-zinc-300",
                    )}
                    style={row.include ? { background: "#1F8A5B", borderColor: "#1F8A5B" } : undefined}
                  >
                    {row.include && <CheckIcon className="size-6" strokeWidth={2.6} />}
                  </button>
                </div>
              </div>

              {!isNew && priceChanged && (
                <div
                  className="flex items-center gap-3 flex-wrap mt-3 px-3.5 py-3 rounded-[14px]"
                  style={{ background: "#fdf6e8", border: "1px solid #f0e0b8" }}
                >
                  <span
                    className="text-xs font-bold tracking-wide rounded px-2 py-1"
                    style={{ color: "#9a7515", background: "#f5e6b8" }}
                  >
                    ↑ {T.scan_price_up}
                  </span>
                  <span className="font-mono text-[15px] text-zinc-600">
                    <span className="line-through text-zinc-400">{money(it!.cost_cents)}</span> →{" "}
                    <b>{money(effCost)}</b>{" "}
                    <span className={pct >= 0 ? "text-orange-700" : "text-emerald-700"}>
                      ({pct >= 0 ? "+" : ""}
                      {pct}%)
                    </span>
                  </span>
                  <span className="flex-1" />
                  <Toggle on={row.applyPrice} onClick={() => set(i, { applyPrice: !row.applyPrice })}>
                    {T.scan_update_price}
                  </Toggle>
                </div>
              )}

              {isNew && (
                <div
                  className="mt-3 p-3.5 rounded-2xl"
                  style={{ background: "#fffdf6", border: "1px dashed #e6cf9a" }}
                >
                  <div className="text-[13px] font-semibold mb-3" style={{ color: "#9a7515" }}>
                    {T.scan_new_details}
                  </div>
                  {row.itemGroup && (
                    <div
                      className="mb-3 flex items-center gap-2 flex-wrap rounded-xl px-3 py-2 text-[12px]"
                      style={{ background: "#f3f1fd", color: "#5B4BD0" }}
                    >
                      <span className="font-semibold">🔗 {T.scan_grouped}</span>
                      <span style={{ color: "#5B4BD0", opacity: 0.75 }}>{T.scan_grouped_hint}</span>
                      <span className="flex-1" />
                      <button
                        type="button"
                        onClick={() => set(i, { itemGroup: "", packLabel: "", packBaseQty: "", needsPackInput: false })}
                        className="rounded-lg border bg-white px-2.5 py-1 font-semibold"
                        style={{ borderColor: "rgba(91,75,208,0.3)" }}
                      >
                        {T.scan_split}
                      </button>
                    </div>
                  )}
                  <div className={cn("grid gap-3", phone ? "grid-cols-1" : "grid-cols-3")}>
                    <NfField label={T.scan_map_to}>
                      <div className="flex items-center gap-2">
                        <select
                          value={row.target}
                          onChange={(e) => {
                            const picked = items.find((c) => c.id === e.target.value);
                            set(i, {
                              target: e.target.value,
                              aiConfidence: undefined,
                              asPack: Boolean(
                                picked && picked.pack_qty > 1 && looksLikePackUnit(row.unit, picked.purchase_unit),
                              ),
                            });
                          }}
                          className={cn(nfCls, "flex-1 min-w-0")}
                        >
                          <option value="__new__">＋ {T.scan_create} “{row.niceName}”</option>
                          {items.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={() => {
                            setScanMiss(null);
                            setScanRow(i);
                          }}
                          aria-label={T.items_scan_camera}
                          title={T.items_scan_camera}
                          className="h-11 w-11 flex-none rounded-xl border border-zinc-200 bg-white text-lg leading-none"
                        >
                          📷
                        </button>
                      </div>
                      {scanMiss?.row === i && (
                        <div className="mt-1 text-[12px] text-amber-700">{T.items_code_not_found}</div>
                      )}
                    </NfField>
                    <NfField label={T.f_category}>
                      <select value={row.cat} onChange={(e) => set(i, { cat: e.target.value })} className={nfCls}>
                        {categories.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </NfField>
                    <NfField label={T.f_price}>
                      <div className="flex items-center h-11 rounded-xl border border-zinc-200 bg-white pl-3">
                        <span className="text-zinc-500 font-mono">$</span>
                        <input
                          type="number"
                          step="0.01"
                          inputMode="decimal"
                          value={(row.priceCents / 100).toFixed(2)}
                          onChange={(e) =>
                            set(i, { priceCents: Math.max(0, Math.round(parseFloat(e.target.value || "0") * 100)) })
                          }
                          className="flex-1 h-10 px-2 bg-transparent border-0 outline-none font-mono text-[15px]"
                        />
                      </div>
                    </NfField>
                    <NfField label={T.f_unit}>
                      <input
                        value={row.newUnit}
                        onChange={(e) => set(i, { newUnit: e.target.value })}
                        className={nfCls}
                      />
                    </NfField>
                    <NfField label={T.f_vendor}>
                      <input
                        value={row.vendor}
                        onChange={(e) => set(i, { vendor: e.target.value })}
                        className={nfCls}
                      />
                    </NfField>
                    <NfField label={`${T.f_par} · ${T.f_optional}`}>
                      <input
                        type="number"
                        inputMode="numeric"
                        placeholder="—"
                        value={row.par}
                        onChange={(e) => set(i, { par: e.target.value })}
                        className={nfCls}
                      />
                    </NfField>
                    <NfField label={`${T.f_par_max} · ${T.f_optional}`}>
                      <input
                        type="number"
                        inputMode="numeric"
                        placeholder="—"
                        value={row.parMax}
                        onChange={(e) => set(i, { parMax: e.target.value })}
                        className={nfCls}
                      />
                    </NfField>
                    {row.itemGroup && (
                      <>
                        <NfField label={T.scan_pack_label}>
                          <input
                            value={row.packLabel}
                            onChange={(e) => set(i, { packLabel: e.target.value })}
                            placeholder={T.scan_pack_label_ph}
                            className={nfCls}
                          />
                        </NfField>
                        <NfField label={`${T.scan_pack_qty} (${row.newUnit || row.unit || "?"})`}>
                          <input
                            type="number"
                            step="0.0001"
                            inputMode="decimal"
                            placeholder="—"
                            value={row.packBaseQty}
                            onChange={(e) => set(i, { packBaseQty: e.target.value, needsPackInput: false })}
                            className={nfCls}
                            style={row.needsPackInput ? { borderColor: "#f59e0b" } : undefined}
                          />
                          {row.needsPackInput && (
                            <div className="mt-1 text-[12px] text-amber-700">{T.scan_pack_needed}</div>
                          )}
                        </NfField>
                      </>
                    )}
                  </div>
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
        {error && (
          <div className="text-center text-sm text-red-600 mb-2">
            {T[writeFailureKey(error)]}
          </div>
        )}
        <button
          onClick={confirm}
          disabled={!active.length || busy}
          className="w-full h-16 rounded-2xl text-white font-semibold text-lg inline-flex items-center justify-center gap-2.5 disabled:bg-zinc-200 disabled:text-zinc-400"
          style={active.length && !busy ? { background: "#1F8A5B", boxShadow: "0 12px 30px -8px rgba(31,138,91,.45)" } : undefined}
        >
          <CheckIcon className="size-6" strokeWidth={2.4} /> {T.scan_import} ({active.length})
        </button>
        <button
          onClick={() => (dirty ? setLeaving("capture") : onCancel())}
          className="w-full text-center text-zinc-400 text-sm mt-2.5"
        >
          {STRINGS[lang].cancel}
        </button>
      </div>

      {leaving && (
        <div className="absolute inset-0 z-50 bg-black/40 flex items-center justify-center p-6">
          <div className="w-full max-w-sm rounded-3xl bg-white p-6 text-center shadow-2xl">
            <div className="text-xl font-semibold tracking-tight text-zinc-900">{T.scan_leave_title}</div>
            <p className="text-zinc-500 text-[15px] mt-2">{T.scan_leave_body}</p>
            <button
              onClick={() => setLeaving(null)}
              className="w-full h-14 rounded-2xl bg-zinc-900 text-white font-semibold text-base mt-5 active:scale-[0.98] transition-transform"
            >
              {T.scan_leave_stay}
            </button>
            <button
              onClick={() => (leaving === "capture" ? onCancel() : onExit())}
              className="w-full h-12 rounded-2xl border border-zinc-200 bg-white text-red-600 font-medium text-sm mt-2.5 active:scale-[0.98] transition-transform"
            >
              {T.scan_leave_discard}
            </button>
          </div>
        </div>
      )}

      {scanRow !== null && (
        <BarcodeScanner
          lang={lang}
          onDetect={(code) => {
            const target = scanRow;
            setScanRow(null);
            void applyScannedCode(target, code);
          }}
          onClose={() => setScanRow(null)}
        />
      )}
    </div>
  );
}

// Parse an optional whole-number par field: blank → undefined ("not set"), else a
// non-negative int. The inputs are type=number so non-numeric is already constrained;
// the Number.isFinite guard is belt-and-suspenders against an empty/garbage parse.
function optInt(raw: string): number | undefined {
  if (!raw.trim()) return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? Math.max(0, n) : undefined;
}

// "LECHE ENTERA GAL" → "Leche Entera Gal" for a friendlier new-item default name.
function prettify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

const nfCls = "h-11 px-3 rounded-xl border border-zinc-200 bg-white text-[15px] outline-none focus:border-violet-500 font-mono";

function NfField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[13px] text-zinc-500 font-medium">{label}</span>
      {children}
    </label>
  );
}

function Stepper({
  qty,
  unit,
  onDec,
  onInc,
  onSet,
}: {
  qty: number;
  unit: string;
  onDec: () => void;
  onInc: () => void;
  onSet: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-0.5 bg-zinc-100 rounded-2xl p-1 flex-none">
      <button onClick={onDec} className="size-12 rounded-xl grid place-items-center text-2xl font-semibold active:bg-zinc-200">
        −
      </button>
      <input
        type="number"
        inputMode="numeric"
        value={qty}
        onChange={(e) => onSet(Math.max(0, parseInt(e.target.value || "0", 10)))}
        className="w-12 text-center bg-transparent border-0 outline-none font-mono text-xl font-semibold [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
      />
      <button onClick={onInc} className="size-12 rounded-xl grid place-items-center text-2xl font-semibold active:bg-zinc-200">
        +
      </button>
      <span className="text-xs text-zinc-500 pl-0.5 pr-2">{unit}</span>
    </div>
  );
}

function Toggle({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-2 h-11 pl-1.5 pr-3.5 rounded-full border text-sm font-medium",
        on ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-zinc-200 bg-white text-zinc-600",
      )}
    >
      <span className={cn("w-9 h-6 rounded-full relative transition-colors", on ? "bg-emerald-600" : "bg-zinc-300")}>
        <span
          className={cn(
            "absolute top-1 size-4 rounded-full bg-white shadow transition-transform",
            on ? "translate-x-3.5 left-1" : "left-1",
          )}
        />
      </span>
      {children}
    </button>
  );
}

function Dot({ delay }: { delay?: string }) {
  return (
    <span
      className="size-2 rounded-full crew-bounce"
      style={{ background: "#6D5AE0", animationDelay: delay }}
    />
  );
}

function CameraIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
      <circle cx="12" cy="13" r="3" />
    </svg>
  );
}

function UploadIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2M12 3v12M7 8l5-5 5 5" />
    </svg>
  );
}

function SparkleIcon({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg className={className} style={style} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2l1.9 5.8L20 9.7l-5.1 1.9L12 17l-1.9-5.4L5 9.7l6.1-1.9z" />
    </svg>
  );
}

function CheckIcon({ className, strokeWidth = 2 }: { className?: string; strokeWidth?: number }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
