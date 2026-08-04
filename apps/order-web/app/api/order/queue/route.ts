import { NextResponse } from "next/server";
import type { QueueEstimate } from "@/lib/types";

// Timestamp must be fresh per request.
export const dynamic = "force-dynamic";

/**
 * GET /api/order/queue — BFF.
 *
 * There is NO kds-api queue endpoint yet: packages/contracts defines
 * QueueEstimateSchema / GET /api/order/queue, but apps/kds-api/src/routes/
 * order.ts implements only menu / order / checkout / status. Until a real
 * kitchen-load source lands, return a clearly-labeled `source: "fallback"`
 * estimate — the exact shape + semantics the UI already treats as "backend was
 * unreachable" (lib/useQueueEstimate.ts keeps the last value and never throws).
 *
 * This keeps the wait-time UI honest — it never shows a fabricated "live"
 * number — instead of erroring. When a real estimate endpoint is added to
 * kds-api, this handler becomes a thin proxy (like menu above).
 */
export async function GET() {
  const estimate: QueueEstimate = {
    minutes: 8,
    queueDepth: 0,
    asOf: new Date().toISOString(),
    source: "fallback",
  };
  return NextResponse.json(estimate);
}
