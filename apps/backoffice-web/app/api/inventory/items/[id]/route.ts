import { NextResponse, type NextRequest } from "next/server";
import type { InventoryItemSave } from "@rop/contracts";

import { analyticsApi } from "@/lib/analytics-api";
import { getSessionUser } from "@/lib/auth/session-user";
import { handleInventoryApiError, inventoryApi } from "@/lib/inventory-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Cap the best-effort plate-cost sync so a slow analytics-api can never stall the
// item-save response (the save itself is already committed upstream).
const SYNC_TIMEOUT_MS = 5_000;

export async function PUT(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ error: "missing_item_id" }, { status: 400 });
  }
  const operator = await getSessionUser(request);
  if (!operator) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  try {
    const body = (await request.json()) as InventoryItemSave;
    const saved = await inventoryApi.saveItem(id, body);

    // An ingredient-cost edit changes every plate cost that uses this item, so
    // re-pull plate costs into analytics' mart (dim_item_cost) — same best-effort,
    // time-bounded pattern as the recipe-save route. The item is already persisted
    // upstream (Iron Law 5); a slow/failing analytics must not affect the save.
    try {
      await analyticsApi.syncPlateCosts({ signal: AbortSignal.timeout(SYNC_TIMEOUT_MS) });
    } catch (error) {
      console.warn(
        `[backoffice.api.inventory.item.plate-cost-sync] saved item ${id}; sync skipped: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }

    return NextResponse.json(saved);
  } catch (error) {
    return handleInventoryApiError(error, "backoffice.api.inventory.item.save");
  }
}
