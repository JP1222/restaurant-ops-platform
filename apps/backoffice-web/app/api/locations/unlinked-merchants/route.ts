import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import type { UnlinkedMerchant } from "@rop/contracts";
import { errorMessage, logErrorEvent } from "@/lib/ai/log";
import { listUnlinkedMerchants } from "@/lib/location/db";
import { getSettingsSessionUser } from "@/lib/settings/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REQUIRED_ROLE = "ADMIN";

// Connected POS store-accounts with no Location binding yet, for the onboarding
// "Bind POS" picker (ADR-0018 step 2). ADMIN-gated like the rest of the Locations
// admin surface. CloverMerchant is the generic store-account table (ADR-0019), so
// this lists Clover and any future non-Clover sources.
export async function GET(request: NextRequest): Promise<Response> {
  const user = await getSettingsSessionUser(request);
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (user.role !== REQUIRED_ROLE) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    const rows = await listUnlinkedMerchants();
    const merchants: UnlinkedMerchant[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      authStatus: row.authStatus,
      connectedAt: row.createdAt.toISOString(),
    }));
    return NextResponse.json({ merchants });
  } catch (error) {
    logErrorEvent({
      scope: "backoffice.api.locations.unlinked_merchants",
      message: errorMessage(error, "list_failed"),
    });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
