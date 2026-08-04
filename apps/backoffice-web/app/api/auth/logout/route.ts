import { NextResponse, type NextRequest } from "next/server";
import { clearAuthCookies, jsonError, logRouteError, validateRequestOrigin } from "@/lib/auth/http";
import { getBackofficeSessionCookieName } from "@/lib/auth/config";
import { getBackofficeAuthService } from "@/lib/auth/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!validateRequestOrigin(request)) {
    return jsonError("Untrusted origin.", 403);
  }

  try {
    const auth = getBackofficeAuthService();
    await auth.destroySession(request.cookies.get(getBackofficeSessionCookieName())?.value);
    const response = NextResponse.json({ ok: true });
    clearAuthCookies(response, auth);
    return response;
  } catch (error) {
    logRouteError("backoffice.auth.logout", error);
    return jsonError("Sign-out failed.", 500);
  }
}
