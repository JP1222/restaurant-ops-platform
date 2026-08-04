import { getSessionFromCookies } from "@rop/auth/next";
import { NextResponse, type NextRequest } from "next/server";
import { getBackofficeSessionCookieName } from "@/lib/auth/config";
import { jsonError, logRouteError } from "@/lib/auth/http";
import { getBackofficeAuthService } from "@/lib/auth/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const auth = getBackofficeAuthService();
    const session = await getSessionFromCookies(request.cookies, auth, {
      cookieName: getBackofficeSessionCookieName()
    });

    if (!session) {
      return jsonError("Authentication required.", 401);
    }

    return NextResponse.json({
      user: session
    });
  } catch (error) {
    logRouteError("backoffice.auth.me", error);
    return jsonError("Session check failed.", 500);
  }
}
