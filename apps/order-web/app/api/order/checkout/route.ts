import { NextResponse } from "next/server";
import {
  OrderConfirmationSchema,
  type OrderCheckoutRequest as ContractCheckoutRequest,
} from "@rop/contracts";
import { orderApiUrl } from "@/lib/server/order-api";
import { centsToDollars, dollarsToCents } from "@/lib/money";
import { CheckoutRequestSchema } from "@/lib/checkout-request-schema";
import type { OrderConfirmation } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * POST /api/order/checkout — BFF. THE MONEY STEP.
 *
 * Forwards the opaque payment token (clv_…) + draft id to kds-api, which
 * charges via Clover Ecommerce, creates + settles a Clover Atomic Order (so it
 * reaches the KDS), and auto-refunds if anything after the charge fails.
 *
 * ⚡ Forwards the CUSTOMER's IP as `x-forwarded-for`: Clover rejects the charge
 * without it, and this BFF is a server-side hop — so the downstream kds-api
 * would otherwise see THIS server's IP, not the shopper's. We pass through the
 * inbound `x-forwarded-for` set by our edge (Traefik/Cloudflare).
 */
export async function POST(request: Request) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid checkout request." }, { status: 400 });
  }

  // Validate the dollars-shaped body before converting. A truthy non-number
  // `tip` would otherwise reach `dollarsToCents` (which throws RangeError on a
  // non-finite input) OUTSIDE this try/catch → an uncaught 500 instead of a
  // clean 400; a JS-coercible value like "5" would silently become a $5 tip.
  // A strict schema rejects both. kds-api re-prices/charges authoritatively, so
  // this is robustness, not a money guard. See lib/checkout-request-schema.ts.
  const parsedBody = CheckoutRequestSchema.safeParse(raw);
  if (!parsedBody.success) {
    return NextResponse.json({ error: "Invalid checkout request." }, { status: 400 });
  }
  const body = parsedBody.data;

  const payload: ContractCheckoutRequest = {
    orderId: body.orderId,
    paymentToken: body.paymentToken,
    tipCents: body.tip ? dollarsToCents(body.tip) : 0,
  };

  const fwd = request.headers.get("x-forwarded-for");

  let upstream: Response;
  try {
    upstream = await fetch(orderApiUrl("/api/order/checkout"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(fwd ? { "x-forwarded-for": fwd } : {}),
      },
      body: JSON.stringify(payload),
      cache: "no-store",
    });
  } catch {
    return NextResponse.json(
      { error: "Could not reach payment. Please try again." },
      { status: 502 },
    );
  }

  if (!upstream.ok) {
    // kds-api: 402 payment_failed · 404 draft expired · 503 not configured.
    // Pass the customer-safe message through; opaque-ify 5xx.
    const detail = (await upstream.json().catch(() => null)) as { error?: string } | null;
    const message =
      detail && typeof detail.error === "string"
        ? detail.error
        : "Payment could not be completed.";
    return NextResponse.json(
      { error: message },
      { status: upstream.status >= 500 ? 502 : upstream.status },
    );
  }

  const parsed = OrderConfirmationSchema.safeParse(
    await upstream.json().catch(() => null),
  );
  if (!parsed.success) {
    return NextResponse.json({ error: "Payment could not be completed." }, { status: 502 });
  }

  const t = parsed.data.totals;
  const res: OrderConfirmation = {
    orderId: parsed.data.orderId,
    ticketNumber: parsed.data.ticketNumber,
    state: parsed.data.state,
    totals: {
      subtotal: centsToDollars(t.subtotalCents),
      tax: centsToDollars(t.taxCents),
      tip: centsToDollars(t.tipCents),
      total: centsToDollars(t.totalCents),
    },
    updatedAt: parsed.data.updatedAt,
  };
  return NextResponse.json(res);
}
