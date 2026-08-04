import { createPrismaClient, Prisma, type Location, type PrismaClient } from "@rop/db-kds";
import { DEFAULT_STORE_HOURS, type StoreHours } from "@rop/contracts";

import { nextAvailableSlug, slugify } from "./slug";

// db-kds client on the dedicated `__ropBackofficeKds.prisma` global shared with
// the other db-kds consumers (settings, ai), so location reads don't open a
// second pool. Kept separate from the db-AUTH client (disjoint schemas). The
// `@rop/db-kds` import is permitted here by the `lib/location/**` ESLint
// carve-out (ADR-0018, extending the ADR-0011 / ADR-0016 bounded-exception pattern).
type KdsGlobals = {
  prisma?: PrismaClient;
};

function getPrisma(): PrismaClient {
  const globals = globalThis as typeof globalThis & {
    __ropBackofficeKds?: KdsGlobals;
  };
  globals.__ropBackofficeKds ??= {};
  globals.__ropBackofficeKds.prisma ??= createPrismaClient();
  return globals.__ropBackofficeKds.prisma;
}

export async function listLocations(): Promise<Location[]> {
  return getPrisma().location.findMany({ orderBy: { name: "asc" } });
}

export async function getLocationById(id: string): Promise<Location | null> {
  return getPrisma().location.findUnique({ where: { id } });
}

// The single store, or null when there are zero or many. Lets a single-store
// deploy (StoreSwitcher hidden, no active-location cookie) still resolve "the
// store" for per-location settings like operating hours.
export async function getSoleLocation(): Promise<Location | null> {
  const rows = await getPrisma().location.findMany({ take: 2 });
  return rows.length === 1 ? (rows[0] ?? null) : null;
}

function isUniqueSlugViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

// Create a store. The slug is derived from the name and deduped against existing
// slugs (Location.slug is unique, so two "Anytown" stores must not collide).
// Hours default to the seed when omitted; a new store carries no POS binding, so
// analytics scoping is unaffected until one is explicitly bound (ADR-0018).
//
// The pre-derived suffix can be claimed by a concurrent create between our read
// and write, so a slug-unique violation re-derives and retries rather than
// failing — store names aren't unique, only the slug is, so suffixing is the
// correct resolution, not an error.
export async function createLocation(args: {
  name: string;
  timezone: string;
  operatingHours?: StoreHours;
}): Promise<Location> {
  const prisma = getPrisma();
  const base = slugify(args.name);
  // StoreHours is a plain JSON-serializable object; the `null` day values are
  // valid JSONB. The double-cast satisfies Prisma's InputJsonValue (which models
  // nested null awkwardly) without loosening the caller's type.
  const operatingHours = (args.operatingHours ??
    DEFAULT_STORE_HOURS) as unknown as Prisma.InputJsonValue;

  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const existing = await prisma.location.findMany({
      where: { slug: { startsWith: base } },
      select: { slug: true },
    });
    const slug = nextAvailableSlug(base, new Set(existing.map((row) => row.slug)));
    try {
      return await prisma.location.create({
        data: { name: args.name, slug, timezone: args.timezone, operatingHours, active: true },
      });
    } catch (error) {
      if (attempt === MAX_ATTEMPTS || !isUniqueSlugViolation(error)) throw error;
    }
  }
  // The loop returns or throws on every path; this is an unreachable guard.
  throw new Error("createLocation: exhausted slug-collision retries");
}

// Lazily provision the first store so a single-store deploy can save per-store
// settings before a second store is onboarded (ADR-0018).
export async function createLocationWithHours(args: {
  name: string;
  timezone: string;
  operatingHours: StoreHours;
}): Promise<Location> {
  return createLocation(args);
}

export async function updateLocationHours(
  id: string,
  args: { timezone: string; operatingHours: StoreHours },
): Promise<Location> {
  return getPrisma().location.update({
    where: { id },
    data: {
      timezone: args.timezone,
      operatingHours: args.operatingHours as unknown as Prisma.InputJsonValue,
    },
  });
}

export async function renameLocation(id: string, name: string): Promise<Location> {
  return getPrisma().location.update({ where: { id }, data: { name } });
}

// Resolve a Location to the POS merchant id that the analytics/KDS read paths
// scope by (ADR-0018: those domains key rows on merchantId, not locationId). A
// Location can bind more than one POS account in the model; today it is 1:1, so
// we take the earliest-connected merchant as the canonical one. Returns null
// when the location has no POS binding yet (e.g. a future non-Clover store).
export async function merchantIdForLocation(locationId: string): Promise<string | null> {
  const merchant = await getPrisma().cloverMerchant.findFirst({
    where: { locationId },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  return merchant?.id ?? null;
}

// Batch version of merchantIdForLocation for the Locations admin list: the
// earliest-connected merchant per location (same canonical rule), resolved in one
// query instead of N so the table can show bound/unbound status cheaply.
export async function merchantIdsForLocations(
  locationIds: string[],
): Promise<Map<string, string>> {
  if (locationIds.length === 0) return new Map();
  const merchants = await getPrisma().cloverMerchant.findMany({
    where: { locationId: { in: locationIds } },
    orderBy: { createdAt: "asc" },
    select: { id: true, locationId: true },
  });
  const byLocation = new Map<string, string>();
  for (const merchant of merchants) {
    // earliest-connected wins (orderBy asc + first-seen), matching merchantIdForLocation.
    if (merchant.locationId && !byLocation.has(merchant.locationId)) {
      byLocation.set(merchant.locationId, merchant.id);
    }
  }
  return byLocation;
}

// Store-accounts with no Location binding yet — connected POS rows waiting to be
// bound during onboarding (ADR-0018 step 2). CloverMerchant is the generic
// store-account table (ADR-0019), so this lists Clover and any future non-Clover
// sources. Ordered oldest-first so the operator sees the longest-unbound first.
export async function listUnlinkedMerchants(): Promise<
  { id: string; name: string | null; authStatus: string; createdAt: Date }[]
> {
  return getPrisma().cloverMerchant.findMany({
    where: { locationId: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, authStatus: true, createdAt: true },
  });
}

// Bind a store-account to a Location (onboarding step 2). The `locationId: null`
// guard in the WHERE makes this bind ONLY a currently-unbound merchant — it can
// never re-point another store's already-bound POS, even on a racing/duplicate
// request. Returns false when the merchant doesn't exist or is already bound; the
// caller validates the Location exists first and maps false -> 409.
export async function bindMerchantToLocation(
  locationId: string,
  merchantId: string,
): Promise<boolean> {
  const result = await getPrisma().cloverMerchant.updateMany({
    where: { id: merchantId, locationId: null },
    data: { locationId },
  });
  return result.count > 0;
}
