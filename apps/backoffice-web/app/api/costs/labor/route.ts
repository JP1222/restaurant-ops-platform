import { NextResponse, type NextRequest } from "next/server";
import { LaborCostSaveSchema } from "@rop/contracts";

import { analyticsApi } from "@/lib/analytics-api";
import { getSessionUser } from "@/lib/auth/session-user";
import { handleInventoryApiError, inventoryApi } from "@/lib/inventory-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SCOPE = "backoffice.api.costs.labor";

/**
 * POST /api/costs/labor — set the operator's labor cost (ADR-0033, Phase 4b), the
 * write-path that finally lights up the Cost dashboard's Labor % and Prime cost cards.
 *
 * Two steps, in order:
 *   1. Persist to inventory-api — the originating write-source. analytics is read-only
 *      OLAP and Backoffice cannot write its mart (Iron Law 5), so labor lives where
 *      plate cost already does and is pulled, not pushed.
 *   2. Trigger analytics' ingest + prime-cost MV refresh so the cards reflect the new
 *      number on the next dashboard load. This is best-effort: the row is already
 *      persisted in step 1, and analytics' periodic mart-refresh-worker will pick it up
 *      anyway, so a transient analytics hiccup must not fail the operator's save.
 */
export async function POST(request: NextRequest) {
  const operator = await getSessionUser(request);
  if (!operator) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const parsed = LaborCostSaveSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_labor_cost", details: parsed.error.issues },
      { status: 400 }
    );
  }

  try {
    await inventoryApi.saveLaborCost(parsed.data);
  } catch (error) {
    return handleInventoryApiError(error, SCOPE);
  }

  try {
    const sync = await analyticsApi.syncLaborCosts();
    return NextResponse.json({ ok: true, sync });
  } catch {
    // Persisted, but the immediate pull failed — the refresh worker will catch up.
    return NextResponse.json({ ok: true, sync: null });
  }
}
