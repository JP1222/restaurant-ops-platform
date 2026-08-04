import { NextResponse } from "next/server";
import { OrderStatusResponseSchema } from "@rop/contracts";
import { orderApiUrl } from "@/lib/server/order-api";
import type { OrderStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/order/[orderId]/status — BFF.
 *
 * Thin proxy to kds-api, which maps Clover `paymentState` → the customer
 * lifecycle (pending_payment / preparing / …). No money fields, so no
 * conversion — validate the contract and pass through.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ orderId: string }> },
) {
  const { orderId } = await params;

  let upstream: Response;
  try {
    upstream = await fetch(
      orderApiUrl(`/api/order/${encodeURIComponent(orderId)}/status`),
      { headers: { accept: "application/json" }, cache: "no-store" },
    );
  } catch {
    return NextResponse.json({ error: "Could not check order status." }, { status: 502 });
  }

  if (!upstream.ok) {
    return NextResponse.json(
      { error: "Order not found." },
      { status: upstream.status >= 500 ? 502 : upstream.status },
    );
  }

  const parsed = OrderStatusResponseSchema.safeParse(
    await upstream.json().catch(() => null),
  );
  if (!parsed.success) {
    return NextResponse.json({ error: "Could not check order status." }, { status: 502 });
  }

  const status: OrderStatus = {
    orderId: parsed.data.orderId,
    ticketNumber: parsed.data.ticketNumber,
    state: parsed.data.state,
    updatedAt: parsed.data.updatedAt,
  };
  return NextResponse.json(status);
}
