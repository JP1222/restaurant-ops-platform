import { getSessionIdFromCookies } from "@rop/auth/next";
import type { NextRequest } from "next/server";
import { getBackofficeSessionCookieName } from "@/lib/auth/config";
import { getBackofficeAuthService } from "@/lib/auth/service";

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
}

/**
 * Resolve the logged-in backoffice operator from the session cookie, server-side.
 *
 * Use this in BFF route handlers that must attribute an action to a real user
 * (e.g. the `who` recorded on an inventory write). The value is derived from the
 * session, never trusted from the request body — the browser cannot assert its
 * own identity. Returns null when no valid session is found.
 */
export async function getSessionUser(request: NextRequest): Promise<SessionUser | null> {
  const sessionId = getSessionIdFromCookies(request.cookies, getBackofficeSessionCookieName());
  if (!sessionId) return null;
  const session = await getBackofficeAuthService().readSession(sessionId);
  if (!session) return null;
  return {
    id: session.accountId,
    username: session.username,
    displayName: session.displayName
  };
}
