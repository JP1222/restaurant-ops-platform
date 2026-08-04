import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { StoreLocationUpdateSchema, type StoreLocation } from "@rop/contracts";
import { errorMessage, logErrorEvent } from "@/lib/ai/log";
import { merchantIdForLocation, renameLocation } from "@/lib/location/db";
import { getSettingsSessionUser } from "@/lib/settings/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REQUIRED_ROLE = "ADMIN";

// Rename a store. Both co-owners may edit any store (ADR-0018 — no per-store
// access gate at this stage). slug/timezone/POS binding are not editable here.
export async function PATCH(
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

  const parsed = StoreLocationUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", details: parsed.error.message },
      { status: 400 },
    );
  }

  try {
    const row = await renameLocation(id, parsed.data.name);
    const location: StoreLocation = {
      id: row.id,
      name: row.name,
      slug: row.slug,
      timezone: row.timezone,
      active: row.active,
      // Rename doesn't touch the POS binding; report the current one.
      merchantId: await merchantIdForLocation(row.id),
    };
    return NextResponse.json({ location });
  } catch (error) {
    logErrorEvent({
      scope: "backoffice.api.locations.rename",
      message: errorMessage(error, "rename_failed"),
      context: { id },
    });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
