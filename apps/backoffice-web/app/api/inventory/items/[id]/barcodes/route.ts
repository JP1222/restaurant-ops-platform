import { NextResponse, type NextRequest } from "next/server";
import type { InventoryBarcodeSave } from "@rop/contracts";

import { getSessionUser } from "@/lib/auth/session-user";
import { handleInventoryApiError, inventoryApi } from "@/lib/inventory-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Map a barcode (UPC/GTIN or printed code) to an item, optionally a pack (ADR-0737).
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
    const body = (await request.json()) as InventoryBarcodeSave;
    return NextResponse.json(await inventoryApi.saveBarcode(id, body));
  } catch (error) {
    return handleInventoryApiError(error, "backoffice.api.inventory.item.barcode.create");
  }
}
