import { NextResponse, type NextRequest } from "next/server";
import { InventorySecuritySettingsSaveSchema } from "@rop/contracts";

import { handleInventoryApiError, inventoryApi } from "@/lib/inventory-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SCOPE = "backoffice.api.inventory.crew.security";

export async function GET() {
  try {
    return NextResponse.json(await inventoryApi.getCrewSecurity());
  } catch (error) {
    return handleInventoryApiError(error, SCOPE);
  }
}

export async function PUT(request: NextRequest) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = InventorySecuritySettingsSaveSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "invalid_body",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message
        }))
      },
      { status: 400 }
    );
  }

  try {
    return NextResponse.json(await inventoryApi.saveCrewSecurity(parsed.data));
  } catch (error) {
    return handleInventoryApiError(error, SCOPE);
  }
}
