import {
  DEFAULT_STORE_HOURS,
  StoreHoursSchema,
  type StoreHours,
  type StoreHoursResponse,
} from "@rop/contracts";

import { ALL_STORES } from "./constants";
import {
  createLocationWithHours,
  getLocationById,
  getSoleLocation,
  listLocations,
  updateLocationHours,
} from "./db";
import { readActiveLocationCookie } from "./scope";
import type { Location } from "@rop/db-kds";

const DEFAULT_TIMEZONE = "America/Chicago";
// Lazily-created first store's display name on a fresh single-store deploy.
const DEFAULT_STORE_NAME = "Anytown";

/**
 * Raised when a write can't resolve a single target store — the route maps it to
 * a 409 so the operator picks a store first. Reads never throw (they fall back to
 * the seed default), so this is write-path only.
 */
export class StoreHoursScopeError extends Error {
  readonly reason: "no_store_selected" | "selected_store_not_found";
  constructor(reason: "no_store_selected" | "selected_store_not_found") {
    super(reason);
    this.name = "StoreHoursScopeError";
    this.reason = reason;
  }
}

function parseHours(value: unknown): StoreHours | null {
  const parsed = StoreHoursSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function toResponse(location: Location): StoreHoursResponse {
  const saved = parseHours(location.operatingHours);
  return {
    locationId: location.id,
    name: location.name,
    timezone: location.timezone || DEFAULT_TIMEZONE,
    hours: saved ?? DEFAULT_STORE_HOURS,
    source: saved ? "location" : "default",
  };
}

// The store these per-location settings apply to: the explicitly-selected store
// (StoreSwitcher cookie), else the sole store on a single-store deploy. null when
// nothing specific resolves (no stores yet, or "All stores" with several).
async function resolveActiveLocation(): Promise<Location | null> {
  const cookie = await readActiveLocationCookie();
  if (cookie && cookie !== ALL_STORES) return getLocationById(cookie);
  return getSoleLocation();
}

/**
 * The seed-default hours response. Used when no store is provisioned yet, and as
 * the safe fallback for read-only consumers (e.g. the Today dashboard) so a
 * db-kds blip degrades to default framing instead of failing the whole view.
 */
export function defaultStoreHoursResponse(): StoreHoursResponse {
  return {
    locationId: null,
    name: null,
    timezone: DEFAULT_TIMEZONE,
    hours: DEFAULT_STORE_HOURS,
    source: "default",
  };
}

/** The active store's hours + timezone, or the seed default when none resolves. */
export async function readStoreHours(): Promise<StoreHoursResponse> {
  const location = await resolveActiveLocation();
  return location ? toResponse(location) : defaultStoreHoursResponse();
}

/**
 * The active store's IANA timezone, resolved from its Location — the same source
 * the Today dashboard frames the day in. Best-effort: a db-kds blip falls back to
 * the default-store zone rather than blanking analytics. Analytics BFF routes use
 * this to bucket day/hour boundaries in the store's OWN zone (multi-store, ADR-0018)
 * instead of a hardcoded America/Chicago that mis-frames a non-Central store #2.
 */
export async function resolveStoreTimeZone(): Promise<string> {
  const hours = await readStoreHours().catch(() => defaultStoreHoursResponse());
  return hours.timezone;
}

/**
 * Persist hours for the active store. Resolution: an explicitly-selected store
 * updates in place; a single-store deploy updates its sole store; a fresh deploy
 * bootstraps the first store; several stores with none selected is ambiguous and
 * rejected (StoreHoursScopeError).
 */
export async function saveStoreHours(update: {
  timezone: string;
  hours: StoreHours;
}): Promise<StoreHoursResponse> {
  const cookie = await readActiveLocationCookie();

  if (cookie && cookie !== ALL_STORES) {
    const selected = await getLocationById(cookie);
    if (!selected) throw new StoreHoursScopeError("selected_store_not_found");
    return toResponse(
      await updateLocationHours(selected.id, {
        timezone: update.timezone,
        operatingHours: update.hours,
      }),
    );
  }

  const all = await listLocations();
  if (all.length === 1) {
    return toResponse(
      await updateLocationHours(all[0]!.id, {
        timezone: update.timezone,
        operatingHours: update.hours,
      }),
    );
  }
  if (all.length === 0) {
    return toResponse(
      await createLocationWithHours({
        name: DEFAULT_STORE_NAME,
        timezone: update.timezone,
        operatingHours: update.hours,
      }),
    );
  }
  throw new StoreHoursScopeError("no_store_selected");
}
