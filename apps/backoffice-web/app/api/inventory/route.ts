import { NextResponse, type NextRequest } from "next/server";

import { handleInventoryApiError, inventoryApi } from "@/lib/inventory-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const includeArchived = request.nextUrl.searchParams.get("include") === "archived";
    return NextResponse.json(await inventoryApi.getDataset({ includeArchived }));
  } catch (error) {
    return handleInventoryApiError(error, "backoffice.api.inventory");
  }
}
