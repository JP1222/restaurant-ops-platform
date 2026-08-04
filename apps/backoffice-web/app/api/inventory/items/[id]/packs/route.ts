import { NextResponse, type NextRequest } from "next/server";
import type { InventoryItemPackSave } from "@rop/contracts";

import { getSessionUser } from "@/lib/auth/session-user";
import { handleInventoryApiError, inventoryApi } from "@/lib/inventory-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Create a packaging conversion for an item (ADR-0737).
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
    const body = (await request.json()) as InventoryItemPackSave;
    return NextResponse.json(await inventoryApi.savePack(id, undefined, body));
  } catch (error) {
    return handleInventoryApiError(error, "backoffice.api.inventory.item.pack.create");
  }
}
