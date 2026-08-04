import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import type { InventoryWasteSubmission } from "@rop/contracts";

import { getSessionUser } from "@/lib/auth/session-user";
import { handleInventoryApiError, inventoryApi } from "@/lib/inventory-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const operator = await getSessionUser(request);
  if (!operator) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  try {
    const body = (await request.json()) as InventoryWasteSubmission;
    // Attribution is server-derived: the recorded actor is the logged-in operator,
    // never a client-supplied `who`. A per-submission idempotency key makes a
    // retried POST a no-op server-side (a client-supplied key is respected).
    return NextResponse.json(
      await inventoryApi.recordWaste({
        ...body,
        who: operator.displayName,
        idempotency_key: body.idempotency_key ?? randomUUID()
      })
    );
  } catch (error) {
    return handleInventoryApiError(error, "backoffice.api.inventory.waste");
  }
}
