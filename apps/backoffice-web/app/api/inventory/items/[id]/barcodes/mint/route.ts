import { NextResponse, type NextRequest } from "next/server";
import type { InventoryBarcodeMintRequest } from "@rop/contracts";

import { getSessionUser } from "@/lib/auth/session-user";
import { handleInventoryApiError, inventoryApi } from "@/lib/inventory-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Mint an internal house code for a no-UPC item (barcode-onboarding ADR, D4). Server-generated
// `YR-#####` code, idempotent per (item, pack); returns the fresh item + the code to print.
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ error: "missing_item_id" }, { status: 400 });
  }
  const operator = await getSessionUser(request);
  if (!operator) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  try {
    const body = (await request.json().catch(() => ({}))) as InventoryBarcodeMintRequest;
    return NextResponse.json(await inventoryApi.mintBarcode(id, body));
  } catch (error) {
    return handleInventoryApiError(error, "backoffice.api.inventory.item.barcode.mint");
  }
}
