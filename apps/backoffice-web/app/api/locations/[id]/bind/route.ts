import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { StoreLocationBindSchema, type StoreLocation } from "@rop/contracts";
import { errorMessage, logErrorEvent } from "@/lib/ai/log";
import { bindMerchantToLocation, getLocationById, merchantIdForLocation } from "@/lib/location/db";
import { getSettingsSessionUser } from "@/lib/settings/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REQUIRED_ROLE = "ADMIN";

// Bind a connected POS store-account to this store — onboarding step 2 (ADR-0018).
// ADMIN-gated. 404 when the Location is unknown; 409 when the merchant is missing
// or already bound to a store (the db guard binds ONLY an unbound merchant, so it
// can never re-point another store's POS). On success returns the store with its
// new merchantId so the switcher/analytics can scope to it.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getSettingsSessionUser(request);
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (user.role !== REQUIRED_ROLE) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = StoreLocationBindSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", details: parsed.error.message },
      { status: 400 },
    );
  }

  try {
    const location = await getLocationById(id);
    if (!location) {
      return NextResponse.json({ error: "location_not_found" }, { status: 404 });
    }

    const bound = await bindMerchantToLocation(id, parsed.data.merchantId);
    if (!bound) {
      // Merchant doesn't exist, or is already bound to a store — the guard never
      // re-points a bound POS, so this is the safe, non-destructive failure.
      return NextResponse.json({ error: "merchant_unavailable" }, { status: 409 });
    }

    const result: StoreLocation = {
      id: location.id,
      name: location.name,
      slug: location.slug,
      timezone: location.timezone,
      active: location.active,
      merchantId: await merchantIdForLocation(location.id),
    };
    return NextResponse.json({ location: result });
  } catch (error) {
    logErrorEvent({
      scope: "backoffice.api.locations.bind",
      message: errorMessage(error, "bind_failed"),
      context: { id },
    });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
