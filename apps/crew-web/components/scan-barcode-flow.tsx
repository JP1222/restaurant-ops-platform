"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { InventoryBarcodeResolve } from "@rop/contracts";

import { applyCount, resolveBarcode, writeFailureReason, type WriteFailure } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useCrewData } from "@/lib/crew-data";
import { STRINGS, writeFailureKey } from "@/lib/strings";
import type { Lang } from "@/lib/types";
import { useCrewSize } from "@/lib/use-crew-size";
import { useIdempotencyKey } from "@/lib/use-idempotency-key";
import { BarcodeScanner } from "./barcode-scanner";
import { ItemThumb } from "./item-thumb";
import { ScanRegisterFlow } from "./scan-register-flow";

// Barcode stock-adjust flow (design handoff §8). A cook scans an item's barcode and
// nudges its on-hand by a SIGNED amount — − for stock pulled/used, + for stock taken
// in — then the camera re-arms for the next scan (the loop IS the batch behavior).
// This is NOT the AI invoice scanner ("scan" screen); it's a single-item nudge.
//
// Stages mirror the prototype: a full-screen camera (reusing <BarcodeScanner>, which
// owns the camera stream + denied/nocam states, ADR-0737) and a white "found" card
// with a single signed stepper. The signed delta is written as a one-item recount via
// applyCount (Key decision Option A — no new endpoint, reuses the audited count path;
// it lands as a "recount" in movement history).
export function ScanBarcodeFlow({
  lang,
  onDone,
  onChanged,
}: {
  lang: Lang;
  // Close the flow → Home (the × on either stage).
  onDone: () => void;
  // Reload the shared dataset after a write so the next scan sees fresh on_hand.
  onChanged?: () => void | Promise<void>;
}) {
  const T = STRINGS[lang];
  const phone = useCrewSize().kind === "phone";
  const { categories } = useCrewData();

  const [stage, setStage] = useState<"camera" | "found">("camera");
  const [found, setFound] = useState<InventoryBarcodeResolve | null>(null);
  // An unknown code awaiting the cook's choice (offer to register), and the code they
  // chose to register (→ hands off to ScanRegisterFlow seeded with it). Previously an
  // unknown code only flashed "not found" and re-armed — there was no way to add it.
  const [offerCode, setOfferCode] = useState<string | null>(null);
  const [registerCode, setRegisterCode] = useState<string | null>(null);
  const [delta, setDelta] = useState(0); // signed, clamped ±99
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<WriteFailure | null>(null);
  const [resolving, setResolving] = useState(false);
  // Remount key for the camera. <BarcodeScanner> decodes once then stops its stream,
  // so re-arming it after a not-found scan (we stay on the camera) means mounting a
  // fresh instance. Bumped on every (re)entry to the camera stage.
  const [camKey, setCamKey] = useState(0);
  const { keyFor, reset } = useIdempotencyKey();

  // Local toast: this flow is a full-screen overlay above the app shell, so it can't
  // ride the shell's lower-stacked toast. Dark pill, bottom-center, auto-dismiss.
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = useCallback((msg: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = setTimeout(() => setToast(null), 1700);
  }, []);
  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  const item = found?.item ?? null;
  const pack = found?.pack ?? null;
  // A pack barcode (a case) counts in packs; the count endpoint takes an absolute base
  // quantity, so multiply the signed pack delta by the pack's base qty when we write —
  // mirroring what the pack_id paths do server-side for waste/receive (ADR-0737). An
  // item-level code (pack null) is already in base units.
  const basePerStep = pack && pack.base_qty_per_pack > 0 ? pack.base_qty_per_pack : 1;
  const stepUnit = pack ? pack.label : (item?.unit ?? "");

  const resolve = async (code: string) => {
    const c = code.trim();
    if (!c || resolving) return;
    setResolving(true);
    try {
      const res = await resolveBarcode(c);
      if (res) {
        setFound(res);
        setDelta(0);
        setError(null);
        setStage("found");
      } else {
        // Unknown code: instead of a dead-end "not found" flash, offer to register it as a
        // new item right here (→ ScanRegisterFlow, which also books a starting count). The
        // camera stays stopped behind the prompt; "Keep scanning" re-arms it.
        setOfferCode(c);
      }
    } catch (e) {
      flash(T[writeFailureKey(writeFailureReason(e))]);
      setCamKey((k) => k + 1);
    } finally {
      setResolving(false);
    }
  };

  const apply = async () => {
    if (!item || delta === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const target = Math.max(0, item.on_hand + delta * basePerStep);
      // Keyed on item + resolved target so a re-tap after a failed/lost response dedups
      // to the same count; reset() after success re-keys the next (separate) scan.
      const key = keyFor(`Scan adjust|${item.id}|${target}`);
      await applyCount({ [item.id]: target }, "Scan barcode", key);
      await onChanged?.();
      reset();
      flash(`${T.scan_pull_done} · ${item.name} ${delta > 0 ? "+" : "−"}${Math.abs(delta)} ${stepUnit}`);
      // Loop back to the camera for the next scan (the batch behavior) — not Home.
      setFound(null);
      setDelta(0);
      setStage("camera");
      setCamKey((k) => k + 1);
      setBusy(false);
    } catch (e) {
      setError(writeFailureReason(e));
      setBusy(false);
    }
  };

  // Signed display + colors: 0 gray, negative teal, positive green; the number keeps
  // its sign, the button label does NOT (the word carries direction — §8c reviewer fix).
  const display = delta > 0 ? `+${delta}` : delta < 0 ? `−${Math.abs(delta)}` : "0";
  const numberColor = delta > 0 ? "#1F8A5B" : delta < 0 ? "#0d9488" : "#a1a1aa";
  const applyBg = delta > 0 ? "#1F8A5B" : delta < 0 ? "#0d9488" : "#d4d4d8";
  const applyLabel =
    delta === 0
      ? T.scan_apply_zero
      : delta > 0
        ? `${T.scan_add_btn} · ${delta} ${stepUnit}`
        : `${T.scan_sub_btn} · ${Math.abs(delta)} ${stepUnit}`;
  const errText = error ? T[writeFailureKey(error)] : null;

  const toastNode = toast && (
    <div
      className="fixed left-1/2 bottom-8 z-[70] -translate-x-1/2 rounded-xl px-5 py-3 text-[15px] font-medium text-white whitespace-nowrap crew-toast-up"
      style={{ background: "rgba(24,24,27,0.92)" }}
      role="status"
      aria-live="polite"
    >
      {toast}
    </div>
  );

  // Cook chose to register the unknown code → hand off to the full register + count flow,
  // seeded so it skips its own camera. Done/closed returns to the adjust scanner.
  if (registerCode) {
    return (
      <ScanRegisterFlow
        lang={lang}
        categories={categories}
        initialCode={registerCode}
        onChanged={onChanged}
        onDone={() => {
          setRegisterCode(null);
          setFound(null);
          setDelta(0);
          setStage("camera");
          setCamKey((k) => k + 1);
        }}
      />
    );
  }

  // Unknown code → offer to register it (or keep scanning). The card sits over the dark
  // camera chrome, same vocabulary as the "found" card.
  if (offerCode) {
    return (
      <>
        <div
          className="fixed inset-0 z-[60] flex flex-col bg-[#0a0a0a] text-white crew-fade-in"
          role="dialog"
          aria-modal="true"
        >
          <div
            className="flex items-center justify-between px-5"
            style={{ paddingTop: "calc(1rem + env(safe-area-inset-top))", paddingBottom: "0.75rem" }}
          >
            <span className="text-[15px] font-semibold">{T.scan_cam_title}</span>
            <button
              onClick={onDone}
              aria-label={T.cancel}
              className="flex size-10 items-center justify-center rounded-full bg-white/15 text-2xl leading-none"
            >
              ×
            </button>
          </div>
          <div className="flex flex-1 items-center justify-center overflow-y-auto px-6 pb-8">
            <div className={cn("w-full max-w-md rounded-3xl bg-white text-zinc-900 crew-pop", phone ? "p-5" : "p-6")}>
              <div className="text-sm font-semibold" style={{ color: "#c2410c" }}>
                {T.items_code_not_found}
              </div>
              <div className="mt-1.5 font-mono text-[13px] text-zinc-500 tabular-nums break-all">{offerCode}</div>
              <p className={cn("text-zinc-700", phone ? "mt-3 text-[15px]" : "mt-3.5 text-base")}>{T.scan_add_q}</p>
              <div className="mt-5 flex gap-2">
                <button
                  onClick={() => {
                    setOfferCode(null);
                    setStage("camera");
                    setCamKey((k) => k + 1);
                  }}
                  className="h-12 flex-none rounded-2xl border border-zinc-200 px-5 font-semibold text-zinc-600"
                >
                  {T.scan_add_dismiss}
                </button>
                <button
                  onClick={() => {
                    setRegisterCode(offerCode);
                    setOfferCode(null);
                  }}
                  className="h-12 flex-1 rounded-2xl font-semibold text-white"
                  style={{ background: "#0d9488" }}
                >
                  {T.scan_add_cta}
                </button>
              </div>
            </div>
          </div>
        </div>
        {toastNode}
      </>
    );
  }

  if (stage === "found" && item) {
    return (
      <>
        <div
          className="fixed inset-0 z-[60] flex flex-col bg-[#0a0a0a] text-white crew-fade-in"
          role="dialog"
          aria-modal="true"
        >
          <div
            className="flex items-center justify-between px-5"
            style={{ paddingTop: "calc(1rem + env(safe-area-inset-top))", paddingBottom: "0.75rem" }}
          >
            <span className="text-[15px] font-semibold">{T.scan_cam_title}</span>
            <button
              onClick={onDone}
              aria-label={T.cancel}
              className="flex size-10 items-center justify-center rounded-full bg-white/15 text-2xl leading-none"
            >
              ×
            </button>
          </div>

          <div className="flex flex-1 items-center justify-center overflow-y-auto px-6 pb-8">
            <div className={cn("w-full max-w-md rounded-3xl bg-white text-zinc-900 crew-pop", phone ? "p-5" : "p-6")}>
              <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: "#0d9488" }}>
                <CheckIcon className="size-[18px]" />
                {T.scan_found}
              </div>

              <div className="mt-3.5 flex items-center gap-4">
                <ItemThumb
                  item={item}
                  className={cn("flex-none", phone ? "size-14 text-[28px]" : "size-16 text-[32px]")}
                  rounded="rounded-[18px]"
                />
                <div className="min-w-0 flex-1">
                  <div className={cn("font-semibold tracking-tight truncate", phone ? "text-lg" : "text-xl")}>
                    {item.name}
                  </div>
                  <div className={cn("font-mono text-zinc-500 mt-0.5 tabular-nums", phone ? "text-xs" : "text-[13px]")}>
                    {item.on_hand} {item.unit} {T.it_in_stock.toLowerCase()}
                  </div>
                </div>
              </div>

              <div className={cn("text-center text-zinc-500", phone ? "mt-4 text-[13px]" : "mt-[18px] text-sm")}>
                {T.scan_adjust_hint}
              </div>

              {/* Signed stepper centered on 0: − teal, + green, big mono number colored. */}
              <div className="mt-3 flex items-center gap-1.5 rounded-[18px] p-2" style={{ background: "#f4f4f5" }}>
                <button
                  onClick={() => setDelta((d) => Math.max(-99, d - 1))}
                  aria-label={T.scan_sub_btn}
                  className={cn(
                    "flex items-center justify-center rounded-2xl bg-white font-semibold leading-none",
                    phone ? "size-14 text-3xl" : "size-16 text-[34px]",
                  )}
                  style={{ color: "#0d9488", boxShadow: "0 1px 2px rgba(0,0,0,0.05)" }}
                >
                  −
                </button>
                <span
                  className={cn("flex-1 text-center font-mono font-bold tabular-nums", phone ? "text-4xl" : "text-[42px]")}
                  style={{ color: numberColor }}
                >
                  {display}
                </span>
                <button
                  onClick={() => setDelta((d) => Math.min(99, d + 1))}
                  aria-label={T.scan_add_btn}
                  className={cn(
                    "flex items-center justify-center rounded-2xl bg-white font-semibold leading-none",
                    phone ? "size-14 text-3xl" : "size-16 text-[34px]",
                  )}
                  style={{ color: "#1F8A5B", boxShadow: "0 1px 2px rgba(0,0,0,0.05)" }}
                >
                  +
                </button>
              </div>

              {errText && <div className="mt-3 text-center text-sm text-red-600">{errText}</div>}

              <button
                onClick={apply}
                disabled={delta === 0 || busy}
                className="mt-5 inline-flex w-full items-center justify-center rounded-2xl font-semibold text-white"
                style={{ height: phone ? 56 : 58, background: applyBg }}
              >
                {applyLabel}
              </button>
            </div>
          </div>
        </div>
        {toastNode}
      </>
    );
  }

  return (
    <>
      <BarcodeScanner key={camKey} lang={lang} onDetect={(code) => void resolve(code)} onClose={onDone} />
      {toastNode}
    </>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
