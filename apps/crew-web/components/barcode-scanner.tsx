"use client";

import { useEffect, useRef, useState } from "react";

import { STRINGS } from "@/lib/strings";
import type { Lang } from "@/lib/types";

// Camera barcode scanner (ADR-0737). The decoder is the `barcode-detector` ponyfill: it uses
// the platform's native `BarcodeDetector` when present (Chrome/Android) and falls back to a
// zxing-wasm core on iOS Safari, which has no native `BarcodeDetector`. It is lazy-imported so
// the WASM core lands in its own chunk and only loads when a cook taps "scan", mirroring how
// `pdfjs-dist` loads only when a PDF invoice is picked (lib/pdf.ts). (Replaces the discontinued
// `@zxing/browser`; same external contract.) The component owns the camera stream end-to-end
// and tears it down on unmount; the parent just resolves the code.

type ScanError = "denied" | "nocam" | "generic";

export function BarcodeScanner({
  lang,
  onDetect,
  onClose,
}: {
  lang: Lang;
  // Fired once with the decoded text; the parent closes the scanner and resolves it.
  onDetect: (code: string) => void;
  onClose: () => void;
}) {
  const T = STRINGS[lang];
  const videoRef = useRef<HTMLVideoElement>(null);
  // Hold the latest onDetect without re-arming the camera effect — it must run exactly once.
  const onDetectRef = useRef(onDetect);
  useEffect(() => {
    onDetectRef.current = onDetect;
  }, [onDetect]);
  const [error, setError] = useState<ScanError | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let rvfcId: number | null = null;
    // Captured for the cleanup so it doesn't read videoRef.current after unmount (the rVFC
    // handle must be cancelled on the same element it was registered on).
    let videoEl: HTMLVideoElement | null = null;
    let cancelled = false;
    let done = false;

    void (async () => {
      // E2E seam: headless CI has no camera and the wasm decoder can't read a blank
      // stream, so a spec injects a decoded value through this flag to drive the
      // resolve → adjust → write path. Production never sets it, so real devices always
      // fall through to the live camera below — the read is the only runtime effect.
      const w = window as unknown as { __E2E_BARCODE__?: string };
      if (w.__E2E_BARCODE__) {
        const injected = w.__E2E_BARCODE__;
        delete w.__E2E_BARCODE__; // consume once, so a re-armed scanner hits the camera
        onDetectRef.current(injected);
        return;
      }
      try {
        const { BarcodeDetector } = await import("barcode-detector/ponyfill");
        if (cancelled) return;
        // The formats Sam's/Walmart packages carry, plus our internal Code128 shelf labels.
        const detector = new BarcodeDetector({
          formats: ["upc_a", "upc_e", "ean_13", "ean_8", "code_128", "code_39", "qr_code"],
        });
        // Own the camera stream directly (the old @zxing reader did this internally); rear
        // camera on phones via facingMode. Ask for HD: small, dense house-code labels (our
        // Code128 Dymo prints) need far more pixels-per-bar than chunky retail UPCs, and the
        // default ~640×480 iOS stream blurs the thin bars together so zxing never reaches the
        // module width it needs — the symptom is a code that simply never decodes.
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: "environment",
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        // Best-effort continuous autofocus for close-up labels. Android honors it; iOS ignores
        // the unsupported key (focusMode isn't in the standard MediaTrack typings), so this is
        // a pure upside wrapped against rejection — the HD frame above is the main win.
        try {
          const [track] = stream.getVideoTracks();
          await track?.applyConstraints({
            advanced: [{ focusMode: "continuous" }],
          } as unknown as MediaTrackConstraints);
        } catch {
          // Device exposes no focus control — keep going with the HD stream.
        }
        const video = videoRef.current;
        if (!video) return;
        videoEl = video;
        video.srcObject = stream;
        await video.play();

        // Region-of-interest crop: decode only a centered band of the frame, drawn to an
        // offscreen canvas at native resolution (no downscale). Fewer pixels to scan AND the
        // small label fills more of the image — which is what lets a dense Code128 house label
        // resolve where a full-frame decode misses it (the same idea as html5-qrcode's `qrbox`).
        // `detect()` takes any CanvasImageSource, so we just hand it the canvas instead of the
        // raw <video>. Cropping the raw frame (not the object-cover view) keeps it CSS-agnostic.
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        // requestVideoFrameCallback (iOS 15.4+) is in lib.dom unevenly across TS versions, so
        // narrow to an optional-method shape rather than depend on the global type.
        type RvfcVideo = HTMLVideoElement & {
          requestVideoFrameCallback?: (cb: () => void) => number;
          cancelVideoFrameCallback?: (handle: number) => void;
        };

        // Serialized decode loop: the next pass is scheduled only once this one resolves, so
        // frames never pile up (first non-empty result wins; `done` guards a late callback).
        // requestVideoFrameCallback drives it off real composited frames and idles with the
        // camera; a setTimeout(150ms) fallback covers older WebKit without it.
        const tick = async () => {
          if (cancelled || done) return;
          try {
            const vw = video.videoWidth;
            const vh = video.videoHeight;
            let source: CanvasImageSource = video;
            if (ctx && vw > 0 && vh > 0) {
              const roiW = Math.round(vw * 0.8);
              const roiH = Math.round(vh * 0.55);
              const sx = Math.round((vw - roiW) / 2);
              const sy = Math.round((vh - roiH) / 2);
              if (canvas.width !== roiW) canvas.width = roiW;
              if (canvas.height !== roiH) canvas.height = roiH;
              ctx.drawImage(video, sx, sy, roiW, roiH, 0, 0, roiW, roiH);
              source = canvas;
            }
            const hit = (await detector.detect(source)).find((r) => r.rawValue);
            if (hit && !done) {
              done = true;
              onDetectRef.current(hit.rawValue);
              return;
            }
          } catch {
            // Transient per-frame decode error (e.g. video not yet sized) — keep scanning.
          }
          if (cancelled || done) return;
          const v = video as RvfcVideo;
          if (typeof v.requestVideoFrameCallback === "function") {
            rvfcId = v.requestVideoFrameCallback(() => void tick());
          } else {
            timer = setTimeout(() => void tick(), 150);
          }
        };
        void tick();
      } catch (e) {
        const name = (e as { name?: string } | undefined)?.name;
        setError(
          name === "NotAllowedError" || name === "SecurityError"
            ? "denied"
            : name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError"
              ? "nocam"
              : "generic",
        );
      }
    })();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (rvfcId !== null) {
        const v = videoEl as
          | (HTMLVideoElement & { cancelVideoFrameCallback?: (handle: number) => void })
          | null;
        v?.cancelVideoFrameCallback?.(rvfcId);
      }
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-black/95 text-white" role="dialog" aria-modal="true">
      <div
        className="flex items-center justify-between px-5"
        style={{ paddingTop: "calc(1rem + env(safe-area-inset-top))", paddingBottom: "0.75rem" }}
      >
        <span className="text-[15px] font-semibold">{T.scan_cam_title}</span>
        <button
          onClick={onClose}
          aria-label={T.cancel}
          className="flex size-10 items-center justify-center rounded-full bg-white/15 text-2xl leading-none"
        >
          ×
        </button>
      </div>

      <div className="relative flex flex-1 items-center justify-center overflow-hidden">
        {error ? (
          <div className="px-8 text-center">
            <div className="mb-4 text-5xl">{error === "denied" ? "🔒" : error === "nocam" ? "📷" : "⚠️"}</div>
            <p className="text-base text-white/90">
              {error === "denied" ? T.scan_cam_denied : error === "nocam" ? T.scan_cam_nocam : T.scan_cam_error}
            </p>
            <button onClick={onClose} className="mt-6 h-12 rounded-2xl bg-white px-6 font-semibold text-zinc-900">
              {T.scan_cam_type_instead}
            </button>
          </div>
        ) : (
          <>
            <video ref={videoRef} className="h-full w-full object-cover" autoPlay muted playsInline />
            {/* Aiming cutout: a transparent frame with a huge spread shadow dims everything around it. */}
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div
                className="aspect-[4/3] w-[78%] max-w-sm rounded-2xl border-2 border-white/80"
                style={{ boxShadow: "0 0 0 100vmax rgba(0,0,0,0.45)" }}
              />
            </div>
            <p
              className="absolute inset-x-0 px-8 text-center text-sm text-white/80"
              style={{ bottom: "calc(2.5rem + env(safe-area-inset-bottom))" }}
            >
              {T.scan_cam_hint}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
