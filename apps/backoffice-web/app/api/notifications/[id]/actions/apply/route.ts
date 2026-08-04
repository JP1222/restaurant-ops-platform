import { webAdminRoleToRole } from "@rop/auth/rbac";
import { ApplyActionRequestSchema } from "@rop/contracts";
import { NextResponse, type NextRequest } from "next/server";

import { getSelfProfile } from "@/lib/auth/profile";
import { getSessionUser } from "@/lib/auth/session-user";
import { handleNotificationsApiError, notificationsApi } from "@/lib/notifications-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// Apply a suggested action. The mutating endpoint — manager-gated here (the
// authoritative `can()`-style RBAC check) AND re-gated server-side by
// notifications-api. The operator identity + role are stamped from the session,
// never trusted from the body.
export async function POST(request: NextRequest, { params }: RouteParams) {
  const user = await getSessionUser(request);
  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const profile = await getSelfProfile(user.id);
  if (!profile) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  // Authoritative gate: only a manager-or-above may apply. STAFF is refused here
  // before the request ever reaches the service.
  if (webAdminRoleToRole(profile.role) === "STAFF") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const raw = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  // The route id is authoritative; the body carries actionId + idempotencyKey.
  const parsed = ApplyActionRequestSchema.safeParse({ ...raw, notificationId: id });
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  try {
    const result = await notificationsApi.applyAction(user.username, profile.role, parsed.data);
    return NextResponse.json(result);
  } catch (error) {
    return handleNotificationsApiError(error, "backoffice.api.notifications.apply-action");
  }
}
