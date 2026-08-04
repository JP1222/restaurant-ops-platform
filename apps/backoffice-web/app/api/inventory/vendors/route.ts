import { NextResponse, type NextRequest } from "next/server";
import type { InventoryVendorSave } from "@rop/contracts";

import { getSessionUser } from "@/lib/auth/session-user";
import { handleInventoryApiError, inventoryApi } from "@/lib/inventory-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const operator = await getSessionUser(request);
  if (!operator) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  try {
    const body = (await request.json()) as InventoryVendorSave;
    return NextResponse.json(await inventoryApi.createVendor(body));
  } catch (error) {
    return handleInventoryApiError(error, "backoffice.api.inventory.vendor.create");
  }
}
