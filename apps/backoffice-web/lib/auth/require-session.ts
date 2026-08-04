import { getSessionFromCookies } from "@rop/auth/next";
import { NextResponse, type NextRequest } from "next/server";
import { getBackofficeSessionCookieName } from "./config";
import { getBackofficeAuthService } from "./service";

// Helper for API routes that need to gate on a valid backoffice session.
// Returns null on success (call your handler), or a 401 NextResponse to
// short-circuit when the request is unauthenticated.
export async function requireSession(request: NextRequest): Promise<NextResponse | null> {
  const auth = getBackofficeAuthService();
  const session = await getSessionFromCookies(request.cookies, auth, {
    cookieName: getBackofficeSessionCookieName(),
  });
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  return null;
}
