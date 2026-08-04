import type { AuthServiceConfig } from "./config.js";

export const WEB_SESSION_COOKIE_NAME = "yr_web_session";
export const WEBAUTHN_FLOW_COOKIE_NAME = "yr_webauthn_flow";

export const WEBAUTHN_FLOW_TTL_SECONDS = 5 * 60;

/**
 * Explicit WebAuthn ceremony timeout (ms) passed to
 * `generateRegistrationOptions` / `generateAuthenticationOptions`. Browsers
 * otherwise default the prompt to anywhere from 60s to 5min. Pinning it to one
 * minute under the Redis flow TTL guarantees the authenticator stops emitting
 * assertions before the challenge is evicted, so we never hit the ambiguous
 * "valid signature for an already-discarded challenge" case (GH #148).
 */
export const WEBAUTHN_TIMEOUT_MS = (WEBAUTHN_FLOW_TTL_SECONDS - 60) * 1000;

export type AuthCookieOptions = {
  path: "/";
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  maxAge?: number;
};

function isSecureCookie(config: AuthServiceConfig) {
  return new URL(config.appBaseUrl).protocol === "https:";
}

export function baseCookieOptions(config: AuthServiceConfig): AuthCookieOptions {
  return {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureCookie(config)
  };
}

export function getSessionCookieOptions(config: AuthServiceConfig, sessionTtlSeconds: number): AuthCookieOptions {
  return {
    ...baseCookieOptions(config),
    maxAge: sessionTtlSeconds
  };
}

export function getFlowCookieOptions(config: AuthServiceConfig): AuthCookieOptions {
  return {
    ...baseCookieOptions(config),
    maxAge: WEBAUTHN_FLOW_TTL_SECONDS
  };
}
