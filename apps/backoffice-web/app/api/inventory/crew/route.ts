import { NextResponse, type NextRequest } from "next/server";
import { InventoryEmployeeCreateRequestSchema } from "@rop/contracts";

import { handleInventoryApiError, inventoryApi } from "@/lib/inventory-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SCOPE = "backoffice.api.inventory.crew";

export async function GET() {
  try {
    return NextResponse.json(await inventoryApi.listCrew());
  } catch (error) {
    return handleInventoryApiError(error, SCOPE);
  }
}

export async function POST(request: NextRequest) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = InventoryEmployeeCreateRequestSchema.safeParse(rawBody);
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
    return NextResponse.json(await inventoryApi.createCrew(parsed.data), { status: 201 });
  } catch (error) {
    if (error && typeof error === "object" && (error as { status?: unknown }).status === 409) {
      return NextResponse.json({ error: "pin_in_use" }, { status: 409 });
    }
    return handleInventoryApiError(error, SCOPE);
  }
}
