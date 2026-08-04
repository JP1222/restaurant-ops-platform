import { cookies } from "next/headers";

import { ACTIVE_LOCATION_COOKIE, ALL_STORES } from "./constants";
import { merchantIdForLocation } from "./db";

// Read the active-store selection the StoreSwitcher persists to a cookie.
// Server-only (uses the Next request scope). Returns null when nothing is
// selected — single-store deploys never set the cookie, so the switcher stays
// hidden and analytics falls back to the env-configured default store.
export async function readActiveLocationCookie(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(ACTIVE_LOCATION_COOKIE)?.value ?? null;
}

// Pure decision: map the active-location cookie value + the resolved merchant id
// to the `merchant_id` the analytics BFF should send, or `undefined` to let
// analytics-api use its env-configured default store. Split out from
// `resolveAnalyticsMerchantId` so the branching is unit-testable without
// mocking the cookie jar or Prisma.
//
//   - no selection / "All stores"        -> undefined (default store; true
//     cross-store consolidation is a later step, once a 2nd store has data)
//   - a specific store WITH a POS binding -> that store's merchant id
//   - a specific store WITHOUT a binding  -> the locationId itself, which
//     matches no mart rows. The dashboard then shows "no data" instead of
//     silently falling back to another store's numbers (wrong-empty beats
//     wrong-data for revenue figures).
export function decideAnalyticsScope(
  cookieValue: string | null,
  merchantId: string | null,
): string | undefined {
  if (!cookieValue || cookieValue === ALL_STORES) return undefined;
  return merchantId ?? cookieValue;
}

// Resolve the `merchant_id` the analytics BFF should scope the current request
// to, based on the active store. `undefined` means "use the analytics-api
// default". Skips the DB lookup entirely on the common single-store path (no
// cookie / "All stores").
export async function resolveAnalyticsMerchantId(): Promise<string | undefined> {
  const cookieValue = await readActiveLocationCookie();
  if (!cookieValue || cookieValue === ALL_STORES) return undefined;
  const merchantId = await merchantIdForLocation(cookieValue);
  return decideAnalyticsScope(cookieValue, merchantId);
}
