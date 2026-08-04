import { NextResponse, type NextRequest } from "next/server";
import type { AdminUserPasskeyListResponse } from "@rop/contracts";
import { jsonError, logRouteError } from "@/lib/auth/http";
import { getBackofficeAuthService } from "@/lib/auth/service";
import { getSessionUser } from "@/lib/auth/session-user";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// List the SESSION account's own passkeys (ADR-0029 P2). Session-scoped: the
// account is the cookie's, never a path/query param — distinct from the
// manage-others route under /api/admin/users/[userId]/passkeys. Reuses the
// shared AdminUserPasskeyListResponse shape ({ passkeys: [...] }).
export async function GET(request: NextRequest) {
  const user = await getSessionUser(request);
  if (!user) {
    return jsonError("Authentication required.", 401);
  }

  try {
    const passkeys = await getBackofficeAuthService().listPasskeys(user.id);
    return NextResponse.json<AdminUserPasskeyListResponse>({ passkeys });
  } catch (error) {
    logRouteError("backoffice.auth.passkeys.list", error);
    return jsonError("Could not load passkeys.", 500);
  }
}
