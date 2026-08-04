import { NextResponse } from "next/server";
import {
  CreateOrderResponseSchema,
  type CreateOrderRequest,
} from "@rop/contracts";
import { orderApiUrl } from "@/lib/server/order-api";
import { centsToDollars, dollarsToCents } from "@/lib/money";
import { OrderRequestSchema } from "@/lib/order-request-schema";
import type { OrderResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * POST /api/order — BFF (draft / pricing).
 *
 * Takes the order-web cart (dollars), converts to the integer-cents contract,
 * and forwards to kds-api — which re-prices authoritatively from the live
 * catalog + a Clover tax quote and persists a Redis draft. Returns the
 * server-authoritative totals (cents → dollars). NO money moves here; the
 * charge is POST /api/order/checkout.
 *
 * Client `unitPrice` is advisory only — kds-api ignores it and re-prices — so a
 * cent of client float drift can never become the charge.
 */
export async function POST(request: Request) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid order." }, { status: 400 });
  }

  // Validate the cart BEFORE the dollars→cents map. The JSON parse above only
  // guards malformed JSON; a well-formed body with a missing/empty `lines`
  // array — or a line whose `unitPrice` / `priceDelta` is non-finite (NaN,
  // Infinity, "abc", null, an object) from a malicious client or a stale
  // localStorage cart — would otherwise reach `dollarsToCents` and throw a
  // RangeError → an unhandled 500 instead of a clean 400. kds-api still
  // re-prices authoritatively, so this is robustness, not a money guard.
  const result = OrderRequestSchema.safeParse(raw);
  if (!result.success) {
    return NextResponse.json({ error: "Invalid order." }, { status: 400 });
  }
  const body = result.data;

  // dollars → integer cents at the boundary. Every numeric field is now a
  // validated finite number, so dollarsToCents cannot throw, and `modifiers`
  // is normalized to an array by the schema.
  const payload: CreateOrderRequest = {
    customerName: body.customerName,
    customerPhone: body.customerPhone,
    customerEmail: body.customerEmail,
    notes: body.notes,
    lines: body.lines.map((l) => ({
      lineId: l.lineId,
      itemId: l.itemId,
      itemName: l.itemName,
      unitPriceCents: dollarsToCents(l.unitPrice),
      quantity: l.quantity,
      modifiers: l.modifiers.map((m) => ({
        id: m.id,
        name: m.name,
        priceDeltaCents: dollarsToCents(m.priceDelta),
      })),
      notes: l.notes,
    })),
  };

  let upstream: Response;
  try {
    upstream = await fetch(orderApiUrl("/api/order"), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
    });
  } catch {
    return NextResponse.json(
      { error: "Could not reach ordering. Please try again." },
      { status: 502 },
    );
  }

  if (!upstream.ok) {
    // Surface kds-api's own 4xx message (e.g. 409 "the menu changed") so the
    // customer sees something actionable; opaque-ify 5xx as a bad gateway.
    const detail = (await upstream.json().catch(() => null)) as { error?: string } | null;
    const message =
      detail && typeof detail.error === "string" ? detail.error : "Could not price your order.";
    return NextResponse.json(
      { error: message },
      { status: upstream.status >= 500 ? 502 : upstream.status },
    );
  }

  const parsed = CreateOrderResponseSchema.safeParse(
    await upstream.json().catch(() => null),
  );
  if (!parsed.success) {
    return NextResponse.json({ error: "Could not price your order." }, { status: 502 });
  }

  const t = parsed.data.totals;
  const res: OrderResponse = {
    orderId: parsed.data.orderId,
    ticketNumber: parsed.data.ticketNumber,
    totals: {
      subtotal: centsToDollars(t.subtotalCents),
      tax: centsToDollars(t.taxCents),
      total: centsToDollars(t.totalCents),
    },
    checkoutUrl: parsed.data.checkoutUrl,
    correlationId: parsed.data.correlationId,
  };
  return NextResponse.json(res);
}
