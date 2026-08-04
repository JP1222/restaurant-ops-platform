import { NextResponse, type NextRequest } from "next/server";
import { AdminUserUpdateRequestSchema } from "@rop/contracts";
import { jsonError, logRouteError, validateRequestOrigin } from "@/lib/auth/http";
import { getSelfProfile, updateSelfProfile } from "@/lib/auth/profile";
import { getSessionUser } from "@/lib/auth/session-user";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Self-service profile (ADR-0029 P2). Account is always the cookie's, never the
// body. GET returns { id, username, displayName, role, passkeyCount } — role is
// READ-ONLY (RBAC manage-others is ADR-0029 P3), and there is NO email channel
// in the suite so no email field. PATCH updates displayName ONLY. db-auth
// read/write lives in lib/auth/profile.ts (Iron Law #3 carve-out).
export async function GET(request: NextRequest) {
  const user = await getSessionUser(request);
  if (!user) {
    return jsonError("Authentication required.", 401);
  }

  try {
    const profile = await getSelfProfile(user.id);
    if (!profile) {
      return jsonError("Account not found.", 404);
    }
    return NextResponse.json(profile);
  } catch (error) {
    logRouteError("backoffice.auth.profile.get", error);
    return jsonError("Could not load profile.", 500);
  }
}

export async function PATCH(request: NextRequest) {
  if (!validateRequestOrigin(request)) {
    return jsonError("Untrusted origin.", 403);
  }

  const user = await getSessionUser(request);
  if (!user) {
    return jsonError("Authentication required.", 401);
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError("invalid_json", 400);
  }

  const parsed = AdminUserUpdateRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return jsonError("invalid_body", 400);
  }

  try {
    const profile = await updateSelfProfile(user.id, parsed.data.displayName);
    return NextResponse.json(profile);
  } catch (error) {
    logRouteError("backoffice.auth.profile.patch", error);
    return jsonError("Could not update profile.", 500);
  }
}
