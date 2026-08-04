import { NextResponse, type NextRequest } from "next/server";
import type { InventoryBarcodeEnrich } from "@rop/contracts";

import { getSessionUser } from "@/lib/auth/session-user";
import { inventoryApi } from "@/lib/inventory-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BLANK: InventoryBarcodeEnrich = {
  registered: false,
  item: null,
  pack: null,
  off: null,
  suggestions: null
};

// Scan-to-register lookup (barcode-onboarding ADR, D3). Proxies to inventory-api, which resolves
// the code against registered barcodes and enriches a miss from the self-hosted Open Food Facts
// index. FAILS OPEN — any transport error (inventory-api unreachable, OFF db not built) returns a
// blank registered:false (200) so the review form opens rather than erroring; a genuinely broken
// API surfaces at the save step instead.
export async function GET(request: NextRequest, context: { params: Promise<{ upc: string }> }) {
  const { upc } = await context.params;
  if (!upc) {
    return NextResponse.json({ error: "missing_upc" }, { status: 400 });
  }
  const operator = await getSessionUser(request);
  if (!operator) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  try {
    return NextResponse.json(await inventoryApi.barcodeLookup(upc));
  } catch {
    return NextResponse.json(BLANK);
  }
}
