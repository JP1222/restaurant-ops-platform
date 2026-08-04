import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDevAuthBypassSession } from "../client/dev-auth-bypass.ts";
import { WEB_SESSION_COOKIE_NAME } from "../server/cookie.ts";
import type { WebAuthService } from "../server/service.ts";
import { buildLoginHref } from "../shared/navigation.ts";
import type { AuthenticatedSession, AuthSession, PasskeySummary } from "../shared/types.ts";

export type CookieReader = {
  get(name: string): { value?: string } | string | undefined;
};

function trimTrailingSlash(value: string) {
  return value.replace(/\/$/, "");
}

function firstNonEmpty(...values: Array<string | undefined>) {
  for (const value of values) {
    if (value && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

async function getRequestOrigin() {
  const headerStore = await headers();
  const proto = firstNonEmpty(headerStore.get("x-forwarded-proto") ?? undefined) ?? "http";
  const host = firstNonEmpty(
    headerStore.get("x-forwarded-host") ?? undefined,
    headerStore.get("host") ?? undefined
  );

  return host ? `${proto}://${host}` : "http://localhost:3000";
}

export async function getServerApiBaseUrl() {
  const configured = firstNonEmpty(
    process.env.INTERNAL_API_BASE_URL,
    process.env.NEXT_PUBLIC_API_BASE_URL,
    process.env.APP_BASE_URL
  );

  if (configured) {
    return trimTrailingSlash(configured);
  }

  return trimTrailingSlash(await getRequestOrigin());
}

async function fetchJson<T>(path: string): Promise<T | null> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();
  const apiBaseUrl = await getServerApiBaseUrl();
  const requestInit: RequestInit = {
    cache: "no-store"
  };

  if (cookieHeader) {
    requestInit.headers = {
      cookie: cookieHeader
    };
  }

  const response = await fetch(`${apiBaseUrl}${path}`, requestInit);

  if (!response.ok) {
    return null;
  }

  return (await response.json()) as T;
}

export function getSessionIdFromCookies(
  cookieStore: CookieReader,
  cookieName = WEB_SESSION_COOKIE_NAME
) {
  const cookie = cookieStore.get(cookieName);
  if (typeof cookie === "string") {
    return cookie || undefined;
  }

  return cookie?.value || undefined;
}

export async function getSessionFromCookies(
  cookieStore: CookieReader,
  auth: Pick<WebAuthService, "destroySession" | "getAccountById" | "getPasskeyCount" | "readSession">,
  options: {
    cookieName?: string;
  } = {}
): Promise<AuthenticatedSession | null> {
  const sessionId = getSessionIdFromCookies(cookieStore, options.cookieName);
  const session = await auth.readSession(sessionId);
  if (!session) {
    return null;
  }

  const account = await auth.getAccountById(session.accountId);
  if (!account) {
    await auth.destroySession(sessionId);
    return null;
  }

  const hasPasskeys = (await auth.getPasskeyCount(account.id)) > 0;
  return {
    authenticated: true,
    username: account.username,
    displayName: account.displayName,
    hasPasskeys
  };
}

export async function getServerAuthSession(): Promise<AuthSession> {
  const devBypassSession = getDevAuthBypassSession();
  if (devBypassSession) {
    return devBypassSession;
  }

  return (await fetchJson<AuthSession>("/api/auth/session")) ?? { authenticated: false };
}

export async function requireServerAuthSession(returnTo: string): Promise<AuthenticatedSession> {
  const session = await getServerAuthSession();
  if (!session.authenticated) {
    redirect(buildLoginHref(returnTo));
  }

  return session;
}

export async function getServerPasskeys(): Promise<PasskeySummary[]> {
  if (getDevAuthBypassSession()) {
    return [];
  }

  const response = await fetchJson<{ passkeys: PasskeySummary[] }>("/api/auth/passkeys");
  return response?.passkeys ?? [];
}
