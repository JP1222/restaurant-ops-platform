import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { getAiSessionUser } from "@/lib/ai/session";
import { vendorPriceLookup } from "@/lib/ai/inventory-snapshot";
import { handleInventoryApiError, inventoryApi } from "@/lib/inventory-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * BFF for the AI `compare_vendor_prices` tool (ADR-0586 Phase 2B / ADR-0589).
 * Reshapes the live dataset's learned aliases into a per-vendor price comparison
 * for the items matching `q`, cheapest first. Read-only: never writes inventory.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const user = await getAiSessionUser(request);
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const q = request.nextUrl.searchParams.get("q");
  if (!q || q.trim().length === 0) {
    return NextResponse.json({ error: "missing_query" }, { status: 400 });
  }

  try {
    const dataset = await inventoryApi.getDataset();
    return NextResponse.json(vendorPriceLookup(dataset, q, new Date().toISOString()));
  } catch (error) {
    return handleInventoryApiError(error, "backoffice.api.ai.inventory.prices");
  }
}
