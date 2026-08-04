import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { StoreHoursUpdateSchema } from "@rop/contracts";

import { errorMessage, logErrorEvent } from "@/lib/ai/log";
import { readStoreHours, saveStoreHours, StoreHoursScopeError } from "@/lib/location/store-hours";
import { getSettingsSessionUser } from "@/lib/settings/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REQUIRED_ROLE = "ADMIN";

// GET — the active store's opening hours + timezone (seed default when no store
// has been provisioned yet). PUT — persist them to that store's Location row,
// lazily creating the first store on a fresh single-store deploy (ADR-0018).
export async function GET(request: NextRequest): Promise<Response> {
  const user = await getSettingsSessionUser(request);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (user.role !== REQUIRED_ROLE) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  try {
    return NextResponse.json(await readStoreHours());
  } catch (error) {
    logErrorEvent({
      scope: "backoffice.api.store-hours.get",
      message: errorMessage(error, "read_failed"),
    });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

export async function PUT(request: NextRequest): Promise<Response> {
  const user = await getSettingsSessionUser(request);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (user.role !== REQUIRED_ROLE) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = StoreHoursUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", details: parsed.error.message },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json(await saveStoreHours(parsed.data));
  } catch (error) {
    if (error instanceof StoreHoursScopeError) {
      return NextResponse.json({ error: error.reason }, { status: 409 });
    }
    logErrorEvent({
      scope: "backoffice.api.store-hours.put",
      message: errorMessage(error, "save_failed"),
    });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
