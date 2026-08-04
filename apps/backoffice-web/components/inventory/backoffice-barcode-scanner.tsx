"use client";

import * as React from "react";
import { CameraOff } from "lucide-react";

import { Button } from "@/components/ui/button";

// Camera barcode scanner for the backoffice catalog editor (barcode-onboarding ADR, D2).
// Same decoder + decode-once-then-stop contract as crew-web's scanner (the `barcode-detector`
// ponyfill: native BarcodeDetector on Chrome/Android, zxing-wasm fallback on iOS Safari), but
// English and the backoffice overlay. Lazy-imports the decoder so the WASM core stays out of the
// main bundle. Camera needs HTTPS on iOS Safari; on local dev over http it fails closed to the
// "Type it instead" path the parent sheet provides.
type ScanError = "denied" | "nocam" | "generic";

const ERROR_COPY: Record<ScanError, string> = {
  denied: "Camera access was blocked. Allow the camera, or type the code instead.",
  nocam: "No camera found on this device. Type the code instead.",
  generic: "The camera could not start. Type the code instead."
};

export function BackofficeBarcodeScanner({
  onDetect,
  onClose
}: {
  onDetect: (code: string) => void;
  onClose: () => void;
}) {
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const onDetectRef = React.useRef(onDetect);
  React.useEffect(() => {
    onDetectRef.current = onDetect;
  }, [onDetect]);
  const [error, setError] = React.useState<ScanError | null>(null);

  React.useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    let done = false;

    void (async () => {
      try {
        const { BarcodeDetector } = await import("barcode-detector/ponyfill");
        if (cancelled) return;
        const detector = new BarcodeDetector({
          formats: ["upc_a", "upc_e", "ean_13", "ean_8", "code_128", "code_39", "qr_code"]
        });
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();

        const tick = async () => {
          if (cancelled || done) return;
          try {
            const hit = (await detector.detect(video)).find((r) => r.rawValue);
            if (hit && !done) {
              done = true;
              onDetectRef.current(hit.rawValue);
              return;
            }
          } catch {
            // Transient per-frame decode error (e.g. video not yet sized) — keep scanning.
          }
          if (!cancelled && !done) timer = setTimeout(() => void tick(), 150);
        };
        timer = setTimeout(() => void tick(), 150);
      } catch (e) {
        const name = (e as { name?: string } | undefined)?.name;
        setError(
          name === "NotAllowedError" || name === "SecurityError"
            ? "denied"
            : name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError"
              ? "nocam"
              : "generic"
        );
      }
    })();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-black/90 text-white" role="dialog" aria-modal="true">
      <div className="flex items-center justify-between px-5 pt-4 pb-3">
        <span className="text-sm font-medium">Scan a barcode</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          className="text-white hover:bg-white/15 hover:text-white"
        >
          Cancel
        </Button>
      </div>

      <div className="relative flex flex-1 items-center justify-center overflow-hidden">
        {error ? (
          <div className="max-w-xs px-8 text-center">
            <CameraOff className="mx-auto mb-4 size-10 text-white/70" aria-hidden="true" />
            <p className="text-sm text-white/90">{ERROR_COPY[error]}</p>
            <Button variant="secondary" className="mt-6" onClick={onClose}>
              Type it instead
            </Button>
          </div>
        ) : (
          <>
            <video ref={videoRef} className="size-full object-cover" autoPlay muted playsInline />
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div
                className="aspect-[4/3] w-[78%] max-w-sm rounded-2xl border-2 border-white/80"
                style={{ boxShadow: "0 0 0 100vmax rgba(0,0,0,0.5)" }}
              />
            </div>
            <p className="absolute inset-x-0 bottom-10 px-8 text-center text-sm text-white/80">
              Point the rear camera at the package barcode.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
