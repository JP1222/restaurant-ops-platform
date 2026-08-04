import { NextResponse, type NextRequest } from "next/server";

import { handleNotificationsApiError, notificationsApi, operatorIdFromRequest } from "@/lib/notifications-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const operatorId = await operatorIdFromRequest(request);
  if (!operatorId) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  try {
    return NextResponse.json(await notificationsApi.list(operatorId));
  } catch (error) {
    return handleNotificationsApiError(error, "backoffice.api.notifications.list");
  }
}
