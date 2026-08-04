import { NextResponse, type NextRequest } from "next/server";
import type { InventoryPurchaseOrderCreate } from "@rop/contracts";

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
    const body = (await request.json()) as InventoryPurchaseOrderCreate;
    return NextResponse.json(await inventoryApi.createPurchaseOrder(body));
  } catch (error) {
    return handleInventoryApiError(error, "backoffice.api.inventory.po.create");
  }
}
