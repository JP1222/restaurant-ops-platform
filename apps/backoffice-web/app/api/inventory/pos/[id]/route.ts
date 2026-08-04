import { NextResponse, type NextRequest } from "next/server";
import type { InventoryPurchaseOrderUpdate } from "@rop/contracts";

import { getSessionUser } from "@/lib/auth/session-user";
import { InventoryApiError } from "@/lib/inventory-api/client";
import { handleInventoryApiError, inventoryApi } from "@/lib/inventory-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// PO line detail (sku + ordered/received qty + agreed unit cost) for the edit
// drawer — the dataset only carries a line count.
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ error: "missing_po_id" }, { status: 400 });
  }
  const operator = await getSessionUser(request);
  if (!operator) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  try {
    return NextResponse.json(await inventoryApi.getPurchaseOrder(id));
  } catch (error) {
    if (error instanceof InventoryApiError && error.status === 404) {
      return NextResponse.json({ error: "po_not_found" }, { status: 404 });
    }
    return handleInventoryApiError(error, "backoffice.api.inventory.po.get");
  }
}

// Edit an open PO. A 409 `po_not_editable` from inventory-api (the PO was
// received or cancelled out from under the editor) is a meaningful operator
// signal, so it's forwarded verbatim rather than flattened to the generic 502.
export async function PUT(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ error: "missing_po_id" }, { status: 400 });
  }
  const operator = await getSessionUser(request);
  if (!operator) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  try {
    const body = (await request.json()) as InventoryPurchaseOrderUpdate;
    // Attribution is server-derived: the recorded actor is the logged-in operator.
    return NextResponse.json(
      await inventoryApi.updatePurchaseOrder(id, { ...body, who: operator.displayName })
    );
  } catch (error) {
    if (error instanceof InventoryApiError && error.status === 409) {
      return NextResponse.json({ error: "po_not_editable" }, { status: 409 });
    }
    return handleInventoryApiError(error, "backoffice.api.inventory.po.update");
  }
}
