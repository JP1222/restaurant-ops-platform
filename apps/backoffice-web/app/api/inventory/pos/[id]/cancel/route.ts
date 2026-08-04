import { NextResponse, type NextRequest } from "next/server";

import { getSessionUser } from "@/lib/auth/session-user";
import { InventoryApiError } from "@/lib/inventory-api/client";
import { handleInventoryApiError, inventoryApi } from "@/lib/inventory-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Cancel an open PO. Idempotent upstream. A 409 `po_not_editable` (the PO was
// already received) is forwarded verbatim so the UI can explain it.
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ error: "missing_po_id" }, { status: 400 });
  }
  const operator = await getSessionUser(request);
  if (!operator) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  try {
    return NextResponse.json(
      await inventoryApi.cancelPurchaseOrder(id, { who: operator.displayName })
    );
  } catch (error) {
    if (error instanceof InventoryApiError && error.status === 409) {
      return NextResponse.json({ error: "po_not_editable" }, { status: 409 });
    }
    return handleInventoryApiError(error, "backoffice.api.inventory.po.cancel");
  }
}
