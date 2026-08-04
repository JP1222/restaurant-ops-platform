import { NextResponse, type NextRequest } from "next/server";

import { getSessionUser } from "@/lib/auth/session-user";
import { InventoryApiError, handleInventoryApiError, inventoryApi } from "@/lib/inventory-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const operator = await getSessionUser(request);
  if (!operator) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  try {
    return NextResponse.json(await inventoryApi.syncSales());
  } catch (error) {
    // inventory-api returns 503 when the analytics sales feed isn't wired yet —
    // an expected pre-deploy state, not a fault. Surface it distinctly so the UI
    // can show a calm "not connected yet" rather than a generic failure.
    if (error instanceof InventoryApiError && error.status === 503) {
      return NextResponse.json({ error: "sales_feed_not_configured" }, { status: 503 });
    }
    return handleInventoryApiError(error, "backoffice.api.inventory.sync-sales");
  }
}
