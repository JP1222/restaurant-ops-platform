import { NextResponse, type NextRequest } from "next/server";
import type { InventoryReceiveSubmission } from "@rop/contracts";

import { getSessionUser } from "@/lib/auth/session-user";
import { handleInventoryApiError, inventoryApi } from "@/lib/inventory-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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
    const body = (await request.json()) as InventoryReceiveSubmission;
    // Attribution is server-derived: the recorded actor is the logged-in
    // operator, never a client-supplied `who`.
    return NextResponse.json(
      await inventoryApi.receivePurchaseOrder(id, { ...body, who: operator.displayName })
    );
  } catch (error) {
    return handleInventoryApiError(error, "backoffice.api.inventory.receive");
  }
}
