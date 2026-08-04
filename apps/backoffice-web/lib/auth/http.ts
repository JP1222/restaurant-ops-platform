import { NextResponse, type NextRequest } from "next/server";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import type { AuthCookieOptions, WebAuthService } from "@rop/auth/server";
import type { AuthenticatedSession } from "@rop/auth";
import { redactSecrets } from "@/lib/redact";
import { getBackofficeAuthConfig, getBackofficeFlowCookieName, getBackofficeSessionCookieName } from "./config";

export type JsonError = {
  error: string;
};

export function jsonError(message: string, status: number) {
  return NextResponse.json<JsonError>({ error: message }, { status });
}

export function readClientIp(request: NextRequest) {
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwardedFor || request.headers.get("x-real-ip") || "127.0.0.1";
}

export function cookieOptions(options: AuthCookieOptions) {
  return {
    httpOnly: options.httpOnly,
    maxAge: options.maxAge,
    path: options.path,
    sameSite: options.sameSite,
    secure: options.secure
  };
}

export function setSessionCookie(response: NextResponse, auth: WebAuthService, sessionId: string) {
  response.cookies.set(
    getBackofficeSessionCookieName(),
    sessionId,
    cookieOptions(auth.getSessionCookieOptions())
  );
}

export function setFlowCookie(response: NextResponse, auth: WebAuthService, flowId: string) {
  response.cookies.set(getBackofficeFlowCookieName(), flowId, cookieOptions(auth.getFlowCookieOptions()));
}

export function clearAuthCookies(response: NextResponse, auth: WebAuthService) {
  const sessionOptions = cookieOptions(auth.getSessionCookieOptions());
  const flowOptions = cookieOptions(auth.getFlowCookieOptions());
  response.cookies.set(getBackofficeSessionCookieName(), "", {
    ...sessionOptions,
    maxAge: 0
  });
  response.cookies.set(getBackofficeFlowCookieName(), "", {
    ...flowOptions,
    maxAge: 0
  });
}

export function clearFlowCookie(response: NextResponse, auth: WebAuthService) {
  response.cookies.set(getBackofficeFlowCookieName(), "", {
    ...cookieOptions(auth.getFlowCookieOptions()),
    maxAge: 0
  });
}

export function buildSessionResponse(input: {
  displayName: string;
  hasPasskeys: boolean;
  username: string;
}): AuthenticatedSession {
  return {
    authenticated: true,
    username: input.username,
    displayName: input.displayName,
    hasPasskeys: input.hasPasskeys
  };
}

export function readFlowId(request: NextRequest, bodyFlowId?: string) {
  return bodyFlowId ?? request.cookies.get(getBackofficeFlowCookieName())?.value;
}

export function logRouteError(scope: string, error: unknown) {
  // Redact secrets before logging: upstream errors can carry a bearer token,
  // DB/Redis URL, or credential blob in their `.message` (audit-2026-05-27
  // #157), which would otherwise land verbatim in Loki.
  const message = redactSecrets(
    error instanceof Error ? error.message : "Unknown backoffice auth error"
  );
  console.error(
    JSON.stringify({
      level: "error",
      scope,
      message
    })
  );
}

export function getExpectedOrigin() {
  return new URL(getBackofficeAuthConfig().appBaseUrl).origin;
}

export function validateRequestOrigin(request: NextRequest) {
  const expected = getExpectedOrigin();
  const origin = request.headers.get("origin");
  if (origin) {
    return origin === expected;
  }

  const referer = request.headers.get("referer");
  if (!referer) {
    return false;
  }

  try {
    return new URL(referer).origin === expected;
  } catch {
    return false;
  }
}

export type PasskeyVerifyBody = {
  challengeId?: string;
  response: AuthenticationResponseJSON;
};
