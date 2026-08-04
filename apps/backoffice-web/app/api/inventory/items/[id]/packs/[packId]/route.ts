import { NextResponse, type NextRequest } from "next/server";
import type { InventoryItemPackSave } from "@rop/contracts";

import { getSessionUser } from "@/lib/auth/session-user";
import { handleInventoryApiError, inventoryApi } from "@/lib/inventory-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Edit a packaging conversion (ADR-0737).
export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ id: string; packId: string }> }
) {
  const { id, packId } = await context.params;
  if (!id || !packId) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }
  const operator = await getSessionUser(request);
  if (!operator) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  try {
    const body = (await request.json()) as InventoryItemPackSave;
    return NextResponse.json(await inventoryApi.savePack(id, packId, body));
  } catch (error) {
    return handleInventoryApiError(error, "backoffice.api.inventory.item.pack.save");
  }
}

// Delete a packaging conversion (idempotent upstream).
export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string; packId: string }> }
) {
  const { id, packId } = await context.params;
  if (!id || !packId) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }
  const operator = await getSessionUser(request);
  if (!operator) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  try {
    await inventoryApi.deletePack(id, packId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleInventoryApiError(error, "backoffice.api.inventory.item.pack.delete");
  }
}
