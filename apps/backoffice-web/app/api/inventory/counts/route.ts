import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import type { InventoryCountSubmission } from "@rop/contracts";

import { analyticsApi } from "@/lib/analytics-api";
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
    const body = (await request.json()) as InventoryCountSubmission;
    // Attribution is server-derived: the recorded actor is the logged-in operator,
    // never a client-supplied `who`. A per-submission idempotency key makes a
    // retried POST a no-op server-side (a client-supplied key is respected).
    const result = await inventoryApi.applyCounts({
      ...body,
      who: operator.displayName,
      idempotency_key: body.idempotency_key ?? randomUUID()
    });
    // A count is the write that changes count-based actual COGS, so best-effort pull
    // it into analytics' mart + refresh the variance MV (ADR-0031) — the Cost
    // dashboard's yield-variance card reflects the new window on the next load. The
    // count is already persisted and analytics' refresh worker would catch up anyway,
    // so a transient sync hiccup must not fail the operator's count. Mirrors the
    // labor-cost write path.
    await analyticsApi.syncActualCogs().catch(() => undefined);
    return NextResponse.json(result);
  } catch (error) {
    return handleInventoryApiError(error, "backoffice.api.inventory.counts");
  }
}
