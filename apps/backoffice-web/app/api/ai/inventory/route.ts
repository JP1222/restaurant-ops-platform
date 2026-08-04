import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { getAiSessionUser } from "@/lib/ai/session";
import { buildInventoryOverview, searchInventory } from "@/lib/ai/inventory-snapshot";
import { handleInventoryApiError, inventoryApi } from "@/lib/inventory-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * BFF for the AI inventory tools (`get_inventory_status`, `find_inventory_item`).
 * Reads the live dataset from inventory-api and reshapes it into a compact,
 * token-frugal snapshot. Read-only: this route never writes inventory. A `q`
 * param switches from the overview to a name/SKU/category search.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const user = await getAiSessionUser(request);
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const dataset = await inventoryApi.getDataset();
    const now = new Date().toISOString();
    const q = request.nextUrl.searchParams.get("q");
    if (q && q.trim().length > 0) {
      return NextResponse.json(searchInventory(dataset, q, now));
    }
    return NextResponse.json(buildInventoryOverview(dataset, now));
  } catch (error) {
    return handleInventoryApiError(error, "backoffice.api.ai.inventory");
  }
}
