import { NextResponse, type NextRequest } from "next/server";
import type { InventoryItemArchive } from "@rop/contracts";

import { getSessionUser } from "@/lib/auth/session-user";
import { handleInventoryApiError, inventoryApi } from "@/lib/inventory-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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
    const body = (await request.json()) as InventoryItemArchive;
    return NextResponse.json(await inventoryApi.setArchived(id, body.archived));
  } catch (error) {
    return handleInventoryApiError(error, "backoffice.api.inventory.item.archive");
  }
}
