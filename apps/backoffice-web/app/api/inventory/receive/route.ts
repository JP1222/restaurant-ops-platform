import { NextResponse, type NextRequest } from "next/server";
import type { InventoryAdHocReceive } from "@rop/contracts";

import { getSessionUser } from "@/lib/auth/session-user";
import { handleInventoryApiError, inventoryApi } from "@/lib/inventory-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Ad-hoc (no-PO) receive (ADR-0538 D2). The actor `who` is derived server-side from
// the session and overrides any client value, mirroring the waste / count / PO-receive
// BFFs — the browser never names the operator.
export async function POST(request: NextRequest) {
  const operator = await getSessionUser(request);
  if (!operator) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  try {
    const body = (await request.json()) as Omit<InventoryAdHocReceive, "who">;
    return NextResponse.json(
      await inventoryApi.receiveAdHoc({ ...body, who: operator.displayName }),
    );
  } catch (error) {
    return handleInventoryApiError(error, "backoffice.api.inventory.receive");
  }
}
