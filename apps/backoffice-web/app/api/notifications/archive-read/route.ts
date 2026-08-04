import { NextResponse, type NextRequest } from "next/server";

import { handleNotificationsApiError, notificationsApi, operatorIdFromRequest } from "@/lib/notifications-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const operatorId = await operatorIdFromRequest(request);
  if (!operatorId) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  try {
    await notificationsApi.archiveRead(operatorId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleNotificationsApiError(error, "backoffice.api.notifications.archive-read");
  }
}
