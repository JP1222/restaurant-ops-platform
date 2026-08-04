import { cookies } from "next/headers";
import {
  getServerApiBaseUrl,
  getServerAuthSession as packageGetServerAuthSession,
  getServerPasskeys as packageGetServerPasskeys,
  getSessionFromCookies,
  getSessionIdFromCookies,
  requireServerAuthSession as packageRequireServerAuthSession
} from "@rop/auth/next";
import type { AuthenticatedSession, AuthSession, PasskeySummary } from "@rop/auth";

export { getServerApiBaseUrl, getSessionFromCookies, getSessionIdFromCookies };
export type { CookieReader } from "@rop/auth/next";

// Playwright e2e opt-in. Mirrors the backoffice-web proxy.ts pattern: the bypass
// only fires when BOTH the env flag is on (set by playwright.config.ts) AND the
// per-test cookie is present, so the existing redirect-asserting specs keep
// exercising the real auth gate.
const E2E_BYPASS_COOKIE = "__e2e_kds_bypass";
const E2E_BYPASS_SESSION: AuthenticatedSession = {
  authenticated: true,
  username: "e2e-kds-web",
  displayName: "E2E Kitchen Admin",
  hasPasskeys: false
};

async function hasE2eBypassCookie(): Promise<boolean> {
  if (process.env.NODE_ENV === "production") {
    return false;
  }

  if (process.env.KDS_E2E_AUTH_BYPASS !== "true") {
    return false;
  }

  const cookieStore = await cookies();
  return cookieStore.get(E2E_BYPASS_COOKIE)?.value === "1";
}

export async function getServerAuthSession(): Promise<AuthSession> {
  if (await hasE2eBypassCookie()) {
    return E2E_BYPASS_SESSION;
  }

  return packageGetServerAuthSession();
}

export async function requireServerAuthSession(returnTo: string): Promise<AuthenticatedSession> {
  if (await hasE2eBypassCookie()) {
    return E2E_BYPASS_SESSION;
  }

  return packageRequireServerAuthSession(returnTo);
}

export async function getServerPasskeys(): Promise<PasskeySummary[]> {
  if (await hasE2eBypassCookie()) {
    return [];
  }

  return packageGetServerPasskeys();
}
