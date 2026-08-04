"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useCrewSize } from "@/lib/use-crew-size";

// On a desktop preview (wide window, landscape) we render a horizontal iPad
// bezel so the design reads as a "kitchen tablet at the prep station". On
// real phones, real iPads, or any narrow/portrait viewport we skip the
// chrome entirely and let the app fill the screen — the bezel is a demo
// affordance, not the product.
export function IPadFrame({
  children,
  time = "11:42",
}: {
  children: ReactNode;
  time?: string;
}) {
  const size = useCrewSize();
  const showBezel = size.kind === "desktop" && size.landscape;
  const frameRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    if (!showBezel) return;
    const recalc = () => {
      const W = 1194 + 80;
      const H = 834 + 80;
      const sx = window.innerWidth / W;
      const sy = window.innerHeight / H;
      setScale(Math.min(sx, sy, 1));
    };
    recalc();
    window.addEventListener("resize", recalc);
    return () => window.removeEventListener("resize", recalc);
  }, [showBezel]);

  if (!showBezel) {
    return (
      // h-dvh (dynamic viewport height), not h-screen (100vh): on iOS 100vh is
      // the *large* viewport and ignores the on-screen toolbar + home indicator,
      // so the app got pinned to a height taller than what's actually visible —
      // the same fixed height on every device regardless of its real screen.
      // dvh tracks the live visible area, so each iPhone fills edge-to-edge and
      // the bottom controls stay reachable. Safe-area insets are handled per
      // top/bottom element (top-bar, numpads, pin-login).
      <div
        className="w-screen h-dvh flex flex-col"
        style={{ background: "#fdf9f3" }}
      >
        {children}
      </div>
    );
  }

  return (
    <div
      className="w-screen h-dvh flex items-center justify-center"
      style={{
        background:
          "radial-gradient(at 50% 30%, #1a1a1a 0%, #050505 100%)",
      }}
    >
      <div
        ref={frameRef}
        style={{ transform: `scale(${scale})`, transformOrigin: "center" }}
      >
        <div
          className="relative rounded-[44px] p-[24px]"
          style={{
            background: "linear-gradient(180deg, #232325 0%, #16161a 100%)",
            boxShadow:
              "0 40px 90px -20px rgba(0,0,0,0.7), inset 0 0 0 1px rgba(255,255,255,0.08)",
            width: 1194 + 48,
            height: 834 + 48,
          }}
        >
          <div
            className="absolute"
            style={{
              top: "50%",
              left: 10,
              transform: "translateY(-50%)",
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "#0c0c0e",
              boxShadow: "inset 0 0 0 1px #2c2c30",
            }}
          />
          <div
            className="relative rounded-[24px] overflow-hidden"
            style={{ width: 1194, height: 834, background: "#fdf9f3" }}
          >
            <div className="absolute top-0 inset-x-0 h-7 px-6 flex items-center justify-between text-[12px] font-semibold text-zinc-700 z-50 pointer-events-none">
              <div className="flex items-center gap-2">
                <span className="font-mono tabular-nums">{time}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="font-semibold tracking-tight">
                  Anytown iPad · Walk-in
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <svg
                  viewBox="0 0 18 12"
                  width="14"
                  height="10"
                  fill="currentColor"
                >
                  <rect x="0" y="9" width="3" height="3" rx="0.5" />
                  <rect x="5" y="6" width="3" height="6" rx="0.5" />
                  <rect x="10" y="3" width="3" height="9" rx="0.5" />
                  <rect x="15" y="0" width="3" height="12" rx="0.5" />
                </svg>
                <svg
                  viewBox="0 0 16 12"
                  width="14"
                  height="10"
                  fill="currentColor"
                >
                  <path d="M8 11.5a1 1 0 100-2 1 1 0 000 2zM4.5 8.2A4.9 4.9 0 018 6.8c1.4 0 2.6.5 3.5 1.4l-1.2 1.2c-.6-.6-1.4-.9-2.3-.9s-1.7.3-2.3.9L4.5 8.2zM1 4.8A9.8 9.8 0 018 1.8a9.8 9.8 0 017 3l-1.2 1.2A8.1 8.1 0 008 3.6a8.1 8.1 0 00-5.8 2.4L1 4.8z" />
                </svg>
                <div className="flex items-center gap-0.5">
                  <span className="font-mono tabular-nums text-[11px]">
                    82%
                  </span>
                  <div
                    className="relative"
                    style={{ width: 22, height: 11 }}
                  >
                    <div className="absolute inset-0 rounded-[3px] border border-current opacity-50" />
                    <div
                      className="absolute inset-0.5 rounded-[2px] bg-current"
                      style={{ width: "82%", height: "auto" }}
                    />
                    <div className="absolute -right-0.5 top-1/2 -translate-y-1/2 w-0.5 h-1.5 bg-current rounded-r-sm" />
                  </div>
                </div>
              </div>
            </div>

            <div className="absolute inset-0 pt-7">{children}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
