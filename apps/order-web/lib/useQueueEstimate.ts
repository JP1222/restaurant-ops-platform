"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { QueueEstimate } from "@/lib/types";

/**
 * Live pickup wait-time estimate.
 *
 *   const { estimate, loading } = useQueueEstimate({ placed: false });
 *   estimate?.minutes   // → 12
 *   estimate?.queueDepth // → 5
 *
 * Calls `api.getQueueEstimate()` once on mount, then re-polls on an
 * interval. The mock api layer resolves immediately with a fallback
 * estimate; when the real backend lands behind `api`, only that file
 * changes — this hook keeps the same surface.
 *
 *   placed=false  → caller is on Cart / Checkout, hasn't placed yet.
 *   placed=true   → caller is on Confirmation, ticket already in queue.
 *
 * NOTE: the POS-neutral `api.getQueueEstimate()` takes no arguments, so
 * `placed` no longer alters the request shape (the Vite app passed it
 * through to a Clover-backed `/api/queue?placed=…`). It is retained on
 * the options object for caller compatibility and as part of the effect
 * key so the estimate re-fetches if a caller flips it.
 *
 * The hook never throws — if the call fails it keeps the previous
 * estimate so the UI always shows a number.
 */
interface Options {
  placed?: boolean;
  /** Disable to stop polling (e.g. component unmounted but still in
   *  AnimatePresence). Defaults to true. */
  enabled?: boolean;
  /** ms between polls. Defaults to 10s so the cart and checkout
   *  pages reflect kitchen load nearly live without hammering the
   *  backend. */
  intervalMs?: number;
}

export function useQueueEstimate({
  placed = false,
  enabled = true,
  intervalMs = 10_000,
}: Options = {}) {
  const [estimate, setEstimate] = useState<QueueEstimate | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const tick = async () => {
      try {
        const data = await api.getQueueEstimate();
        if (!cancelled) {
          setEstimate(data);
          setLoading(false);
        }
      } catch {
        // Keep the previous estimate. Loading stays true on the very
        // first failed call so the caller can show a skeleton if it
        // wants.
      }
    };

    tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [placed, enabled, intervalMs]);

  return { estimate, loading };
}
