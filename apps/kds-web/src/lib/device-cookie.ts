// Device-pairing cookies (ADR-0818 Phase-2b). Same names kds-api sets/reads
// (apps/kds-api/src/lib/kds-auth.ts `DEVICE_TOKEN_COOKIE_NAME`). kds-web and
// kds-api are SAME-ORIGIN in prod, so the HttpOnly token cookie kds-api sets on
// pairing redeem is sent on every board→kds-api call + the WS handshake, and the
// board RSC can read it. The token cookie is the credential; this merchant cookie
// is just the bound store id (non-secret) so the paired board can scope its calls.
export const DEVICE_TOKEN_COOKIE_NAME = "yr_device_token";
export const DEVICE_MERCHANT_COOKIE_NAME = "yr_device_merchant";

// Client-side: persist the device's bound store id. Long-lived; only a storage
// wipe clears it (the token cookie is the real durable credential).
export function writeDeviceMerchantCookie(merchantId: string) {
  const tenYears = 10 * 365 * 24 * 60 * 60;
  const secure = typeof location !== "undefined" && location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${DEVICE_MERCHANT_COOKIE_NAME}=${encodeURIComponent(merchantId)}; Path=/; Max-Age=${tenYears}; SameSite=Lax${secure}`;
}
