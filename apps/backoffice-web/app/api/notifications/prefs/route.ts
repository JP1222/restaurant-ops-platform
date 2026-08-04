import { NextResponse, type NextRequest } from "next/server";

import { UpdatePrefsRequestSchema } from "@rop/contracts";

import { handleNotificationsApiError, notificationsApi, operatorIdFromRequest } from "@/lib/notifications-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const operatorId = await operatorIdFromRequest(request);
  if (!operatorId) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  try {
    return NextResponse.json(await notificationsApi.getPrefs(operatorId));
  } catch (error) {
    return handleNotificationsApiError(error, "backoffice.api.notifications.prefs.get");
  }
}

export async function PATCH(request: NextRequest) {
  const operatorId = await operatorIdFromRequest(request);
  if (!operatorId) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const parsed = UpdatePrefsRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_prefs", issues: parsed.error.issues }, { status: 400 });
  }
  try {
    return NextResponse.json(await notificationsApi.updatePrefs(operatorId, parsed.data));
  } catch (error) {
    return handleNotificationsApiError(error, "backoffice.api.notifications.prefs.patch");
  }
}
