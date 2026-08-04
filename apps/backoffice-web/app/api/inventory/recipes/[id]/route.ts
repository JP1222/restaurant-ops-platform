import { NextResponse, type NextRequest } from "next/server";
import type { InventoryRecipeSave } from "@rop/contracts";

import { analyticsApi } from "@/lib/analytics-api";
import { getSessionUser } from "@/lib/auth/session-user";
import { handleInventoryApiError, inventoryApi } from "@/lib/inventory-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Cap the best-effort plate-cost sync so a slow analytics-api can never stall the
// recipe-save response (the save itself is already committed upstream).
const SYNC_TIMEOUT_MS = 5_000;

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ error: "missing_recipe_id" }, { status: 400 });
  }
  const operator = await getSessionUser(request);
  if (!operator) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  try {
    return NextResponse.json(await inventoryApi.getRecipeDetail(id));
  } catch (error) {
    return handleInventoryApiError(error, "backoffice.api.inventory.recipe.get");
  }
}

export async function PUT(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ error: "missing_recipe_id" }, { status: 400 });
  }
  const operator = await getSessionUser(request);
  if (!operator) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  try {
    const body = (await request.json()) as InventoryRecipeSave;
    const saved = await inventoryApi.saveRecipe(id, body);

    // A recipe (BOM) edit is the event that changes plate cost. Pull the new
    // cost into analytics' mart (dim_item_cost) so Menu Engineering and the Cost
    // dashboard's food-cost / gross-margin numbers reflect it — mirrors the
    // labor/actual-COGS sync routes. Best-effort + time-bounded: the recipe is
    // already persisted in inventory-api (the write source, Iron Law 5), so a slow
    // or failing analytics must not stall or fail the save; plate cost then
    // refreshes on the next successful save.
    try {
      await analyticsApi.syncPlateCosts({ signal: AbortSignal.timeout(SYNC_TIMEOUT_MS) });
    } catch (error) {
      console.warn(
        `[backoffice.api.inventory.recipe.plate-cost-sync] saved recipe ${id}; sync skipped: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }

    return NextResponse.json(saved);
  } catch (error) {
    return handleInventoryApiError(error, "backoffice.api.inventory.recipe.save");
  }
}
