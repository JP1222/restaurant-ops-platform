import { NextResponse, type NextRequest } from "next/server";

import { handleInventoryApiError, inventoryApi } from "@/lib/inventory-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Archived receipt scans for the Receiving "history" view (receipt-archive). Optional
// ?from / ?to opaque "YYYY-MM-DD" day bounds pass straight through to inventory-api;
// omitted => its recent default window. The session proxy already gates this route.
export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const opts: { from?: string; to?: string } = {};
    const from = sp.get("from");
    const to = sp.get("to");
    if (from) {
      opts.from = from;
    }
    if (to) {
      opts.to = to;
    }
    return NextResponse.json(await inventoryApi.getReceipts(opts));
  } catch (error) {
    return handleInventoryApiError(error, "backoffice.api.inventory.receipts");
  }
}
