import { NextResponse, type NextRequest } from "next/server";
import type { InventoryRecipeCreate } from "@rop/contracts";

import { getSessionUser } from "@/lib/auth/session-user";
import { handleInventoryApiError, inventoryApi } from "@/lib/inventory-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Create a new recipe (menu item) header. The BOM is filled in afterward via the
// editor (PUT /recipes/:id). Mirrors the POST /items create BFF.
export async function POST(request: NextRequest) {
  const operator = await getSessionUser(request);
  if (!operator) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  try {
    const body = (await request.json()) as InventoryRecipeCreate;
    return NextResponse.json(await inventoryApi.createRecipe(body), { status: 201 });
  } catch (error) {
    return handleInventoryApiError(error, "backoffice.api.inventory.recipe.create");
  }
}
