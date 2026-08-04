import type { AuthServiceConfig } from "@rop/auth/server";

function trimTrailingSlash(value: string) {
  return value.replace(/\/$/, "");
}

function readBaseUrl() {
  return trimTrailingSlash(
    process.env.WEBAUTHN_ORIGIN ??
      process.env.APP_BASE_URL ??
      process.env.NEXT_PUBLIC_APP_BASE_URL ??
      "http://localhost:3001"
  );
}

export function getBackofficeSessionCookieName() {
  return process.env.BACKOFFICE_SESSION_COOKIE_NAME ?? "rop_backoffice_session";
}

export function getBackofficeFlowCookieName() {
  return process.env.BACKOFFICE_WEBAUTHN_FLOW_COOKIE_NAME ?? "rop_backoffice_webauthn_flow";
}

export function getBackofficeAuthConfig(): AuthServiceConfig {
  return {
    appBaseUrl: readBaseUrl(),
    webauthnRpId: process.env.WEBAUTHN_RP_ID ?? "localhost",
    webauthnRpName: process.env.WEBAUTHN_RP_NAME ?? "Example Kitchen Backoffice",
    webSessionTtlHours: Number(process.env.WEB_SESSION_TTL_HOURS ?? 12),
    webLoginDisplayName: "Backoffice Admin"
  };
}

export function getRedisUrl() {
  return process.env.REDIS_URL ?? "redis://localhost:6379";
}
