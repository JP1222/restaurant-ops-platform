"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useCart } from "@/lib/cartStore";
import { brand } from "@/lib/brand";
import { useQueueEstimate } from "@/lib/useQueueEstimate";
import type { OrderStatus } from "@/lib/types";
import { Confetti } from "@/components/brand-visuals";

/** Map server state → which tracker step is active (Received/Preparing/Ready). */
function stepIndexFor(state: OrderStatus["state"] | undefined): number {
  switch (state) {
    case "preparing":
      return 1;
    case "ready":
    case "completed":
      return 2;
    case "paid":
      return 0;
    default:
      return 0; // just landed here → payment succeeded, show "Received"
  }
}

export function Confirmation({ orderId: propOrderId }: { orderId?: string }) {
  const router = useRouter();
  const clearCart = useCart((s) => s.clear);
  const [status, setStatus] = useState<OrderStatus | null>(null);

  const orderId = propOrderId && !propOrderId.startsWith("{") ? propOrderId : "";
  const { estimate } = useQueueEstimate({ placed: true });
  const eta = estimate?.minutes ?? 8;

  // Payment succeeded by the time we're here — empty the cart for next time.
  useEffect(() => {
    clearCart();
  }, [clearCart]);

  // Status polling — fast (2s) for the first 30s, then 5s.
  useEffect(() => {
    if (!orderId) return;
    let stop = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const startedAt = Date.now();
    const poll = async () => {
      try {
        const s = await api.getOrderStatus(orderId);
        if (!stop) setStatus(s);
        // Terminal state — stop polling. Without this the finally below
        // reschedules forever, polling every 5s for as long as the tab is open.
        if (s.state === "completed" || s.state === "cancelled") {
          stop = true;
          return;
        }
      } catch {
        /* transient — keep polling */
      } finally {
        if (!stop) timeoutId = setTimeout(poll, Date.now() - startedAt < 30_000 ? 2_000 : 5_000);
      }
    };
    poll();
    return () => {
      stop = true;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [orderId]);

  const ticket = useMemo(() => {
    if (status?.ticketNumber) return status.ticketNumber;
    if (orderId) return orderId.slice(-6).toUpperCase();
    return "------";
  }, [status?.ticketNumber, orderId]);

  const activeIdx = Math.max(0, stepIndexFor(status?.state));
  const steps = [
    { k: "Received", ic: "✓", t: "Just now" },
    { k: "Preparing", ic: "🍦", t: "~2 min" },
    { k: "Ready", ic: "🛍️", t: `~${eta} min` },
  ];

  return (
    <div className="yr confirm">
      <div className="yr-scroll">
        <div style={{ maxWidth: 620, margin: "0 auto", width: "100%" }}>
          <div className="confirm-hero" style={{ position: "relative" }}>
            <Confetti />
            <div className="confirm-burst" style={{ position: "relative" }}>
              <div
                style={{
                  width: 96,
                  height: 96,
                  borderRadius: 999,
                  background: "var(--mint)",
                  border: "2.5px solid var(--ink)",
                  display: "grid",
                  placeItems: "center",
                  fontSize: 46,
                  boxShadow: "0 6px 0 var(--ink)",
                }}
              >
                🎉
              </div>
            </div>
            <div className="eyebrow" style={{ marginBottom: 8 }}>
              Order placed
            </div>
            <h2>You only ROLL once!</h2>
            <div className="ordno">ORDER #{ticket}</div>
          </div>

          <div className="tracker">
            <div className="eyebrow" style={{ marginBottom: 4 }}>
              Live status
            </div>
            <div className="track-steps">
              {steps.map((s, i) => (
                <div key={s.k} className={"track-step " + (i < activeIdx ? "done" : i === activeIdx ? "cur" : "")}>
                  <div className="dot">{s.ic}</div>
                  <div className="tl">{s.k}</div>
                  <div className="ts">{s.t}</div>
                </div>
              ))}
            </div>
            <p style={{ fontSize: 12.5, color: "var(--ink-2)", textAlign: "center", margin: "12px 0 0" }}>
              We’ll text you the second it’s ready. The show happens when you arrive. 🍦
            </p>
          </div>

          <div style={{ padding: 16 }}>
            <div className="card" style={{ padding: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <span style={{ fontWeight: 800, fontSize: 15 }}>Pickup at</span>
                <span className="eyebrow">Pickup only</span>
              </div>
              <div style={{ fontSize: 13.5, color: "var(--ink-2)" }}>
                {brand.location}
                <br />
                Anytown Mall · Anytown, ST
              </div>
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
              <button className="btn btn-ghost press" style={{ flex: 1 }} type="button" onClick={() => router.push("/")}>
                Back to start
              </button>
              <button className="btn btn-mint press" style={{ flex: 1 }} type="button" onClick={() => router.push("/menu")}>
                Order again
              </button>
            </div>
            <p style={{ textAlign: "center", fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--ink-3)", letterSpacing: ".1em", marginTop: 18 }}>
              MADE IN ANYTOWN, ST ♥
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
