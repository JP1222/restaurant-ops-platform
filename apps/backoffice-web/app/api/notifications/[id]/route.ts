import { NextResponse, type NextRequest } from "next/server";

import { handleNotificationsApiError, notificationsApi, operatorIdFromRequest } from "@/lib/notifications-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// One row mutation: { action: "read" | "dismiss" | "snooze", until? }. Snooze
// carries an ISO `until`; the service validates it is in the future.
export async function POST(request: NextRequest, { params }: RouteParams) {
  const operatorId = await operatorIdFromRequest(request);
  if (!operatorId) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const { id } = await params;
  if (typeof id !== "string" || id.length === 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const body = (await request.json().catch(() => ({}))) as { action?: string; until?: unknown };

  try {
    switch (body.action) {
      case "read":
        await notificationsApi.markRead(operatorId, id);
        break;
      case "dismiss":
        await notificationsApi.dismiss(operatorId, id);
        break;
      case "snooze":
        if (typeof body.until !== "string") {
          return NextResponse.json({ error: "snooze requires an ISO until" }, { status: 400 });
        }
        await notificationsApi.snooze(operatorId, id, body.until);
        break;
      default:
        return NextResponse.json({ error: "unknown action" }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleNotificationsApiError(error, "backoffice.api.notifications.action");
  }
}
