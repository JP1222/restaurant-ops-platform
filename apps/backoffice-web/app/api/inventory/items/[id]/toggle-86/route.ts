import { NextResponse } from "next/server";

import { handleInventoryApiError, inventoryApi } from "@/lib/inventory-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ error: "missing_item_id" }, { status: 400 });
  }
  try {
    return NextResponse.json(await inventoryApi.toggle86(id));
  } catch (error) {
    return handleInventoryApiError(error, "backoffice.api.inventory.toggle86");
  }
}
