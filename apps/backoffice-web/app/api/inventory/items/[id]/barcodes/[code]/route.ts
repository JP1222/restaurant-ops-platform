import { NextResponse, type NextRequest } from "next/server";

import { getSessionUser } from "@/lib/auth/session-user";
import { handleInventoryApiError, inventoryApi } from "@/lib/inventory-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Remove a barcode mapping (idempotent upstream) (ADR-0737).
export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string; code: string }> }
) {
  const { id, code } = await context.params;
  if (!id || !code) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }
  const operator = await getSessionUser(request);
  if (!operator) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  try {
    await inventoryApi.deleteBarcode(id, code);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleInventoryApiError(error, "backoffice.api.inventory.item.barcode.delete");
  }
}
