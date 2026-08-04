import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { StoreLocationCreateSchema, type StoreLocation } from "@rop/contracts";
import { errorMessage, logErrorEvent } from "@/lib/ai/log";
import { createLocation, listLocations, merchantIdsForLocations } from "@/lib/location/db";
import { getSettingsSessionUser } from "@/lib/settings/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REQUIRED_ROLE = "ADMIN";

// Lists the brand's stores for the location switcher (Phase 2) and any
// location-scoped admin surface. Read-only; both co-owners see every store
// (ADR-0018 — no per-store access gate at this stage).
export async function GET(request: NextRequest): Promise<Response> {
  const user = await getSettingsSessionUser(request);
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (user.role !== REQUIRED_ROLE) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    const rows = await listLocations();
    const merchantByLocation = await merchantIdsForLocations(rows.map((row) => row.id));
    const locations: StoreLocation[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      timezone: row.timezone,
      active: row.active,
      merchantId: merchantByLocation.get(row.id) ?? null,
    }));
    return NextResponse.json({ locations });
  } catch (error) {
    logErrorEvent({
      scope: "backoffice.api.locations.list",
      message: errorMessage(error, "list_failed"),
    });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

// Create a new store (multi-store onboarding, ADR-0018). ADMIN-gated. The new
// store has no POS binding yet, so analytics shows no data for it until one is
// bound; hours seed to the default and are edited in Settings → Store Hours.
// Store names are not unique (the unique slug is derived + deduped server-side),
// so a duplicate name is allowed rather than rejected.
export async function POST(request: NextRequest): Promise<Response> {
  const user = await getSettingsSessionUser(request);
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (user.role !== REQUIRED_ROLE) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = StoreLocationCreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", details: parsed.error.message },
      { status: 400 },
    );
  }

  try {
    const row = await createLocation({
      name: parsed.data.name,
      timezone: parsed.data.timezone,
    });
    const location: StoreLocation = {
      id: row.id,
      name: row.name,
      slug: row.slug,
      timezone: row.timezone,
      active: row.active,
      // A freshly created store has no POS binding yet (onboarding step 2 binds one).
      merchantId: null,
    };
    return NextResponse.json({ location }, { status: 201 });
  } catch (error) {
    logErrorEvent({
      scope: "backoffice.api.locations.create",
      message: errorMessage(error, "create_failed"),
    });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
