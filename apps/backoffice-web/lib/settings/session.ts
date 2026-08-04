import { getSessionIdFromCookies } from "@rop/auth/next";
import type { NextRequest } from "next/server";
import { getBackofficeSessionCookieName } from "@/lib/auth/config";
import { getBackofficeAuthService } from "@/lib/auth/service";

export interface SettingsSessionUser {
  id: string;
  username: string;
  displayName: string;
  role: string;
}

export async function getSettingsSessionUser(
  request: NextRequest,
): Promise<SettingsSessionUser | null> {
  const sessionId = getSessionIdFromCookies(request.cookies, getBackofficeSessionCookieName());
  if (!sessionId) return null;
  const auth = getBackofficeAuthService();
  const session = await auth.readSession(sessionId);
  if (!session) return null;
  return {
    id: session.accountId,
    username: session.username,
    displayName: session.displayName,
    role: session.role,
  };
}
