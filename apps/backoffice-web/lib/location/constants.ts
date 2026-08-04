// Shared identifiers for the active-store selection. Kept dependency-free (no
// next/headers, no Prisma) so the client switcher
// (components/locations/store-switcher.tsx) and the server-side scope resolver
// (lib/location/scope.ts) can both import the same literals.

export const ACTIVE_LOCATION_COOKIE = "yr_active_location";

// Sentinel cookie value for the "All stores" aggregate selection.
export const ALL_STORES = "all";
