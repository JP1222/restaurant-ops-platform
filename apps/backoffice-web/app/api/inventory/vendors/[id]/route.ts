import { NextResponse, type NextRequest } from "next/server";
import type { InventoryVendorSave } from "@rop/contracts";

import { getSessionUser } from "@/lib/auth/session-user";
import { handleInventoryApiError, inventoryApi } from "@/lib/inventory-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PUT(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ error: "missing_vendor_id" }, { status: 400 });
  }
  const operator = await getSessionUser(request);
  if (!operator) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  try {
    const body = (await request.json()) as InventoryVendorSave;
    return NextResponse.json(await inventoryApi.saveVendor(id, body));
  } catch (error) {
    return handleInventoryApiError(error, "backoffice.api.inventory.vendor.save");
  }
}
