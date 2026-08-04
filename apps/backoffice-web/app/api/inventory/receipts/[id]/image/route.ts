import { NextResponse, type NextRequest } from "next/server";

import { fetchReceiptImageUpstream, handleInventoryApiError } from "@/lib/inventory-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Proxy an archived receipt image from inventory-api so an <img src> renders it
// same-origin (the browser can't reach inventory-api — Iron Law 4). The session proxy
// already gates this route, so the read needs no extra auth here. The image is
// immutable per receive, so it may cache briefly (private).
export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ error: "missing_receipt_id" }, { status: 400 });
  }
  try {
    const upstream = await fetchReceiptImageUpstream(id);
    if (!upstream.ok) {
      return new NextResponse(null, { status: upstream.status });
    }
    const body = await upstream.arrayBuffer();
    return new NextResponse(body, {
      status: 200,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
        "cache-control": "private, max-age=3600"
      }
    });
  } catch (error) {
    return handleInventoryApiError(error, "backoffice.api.inventory.receipt.image.get");
  }
}
