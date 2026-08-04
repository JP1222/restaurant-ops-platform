import { IntegrationEnvironment, OrderProvider, type PrismaClient } from "@rop/db-kds";
import type { OrderMenuResponse, SquareEnvironment } from "@rop/contracts";

import {
  normalizeSquareCatalog,
  summarizeSquareCatalog,
  type SquareCatalogCounts,
  type SquareCatalogObject,
} from "../domain/normalize-square-catalog.js";
import { resolvePosAccessToken } from "./pos-token.js";
import type { SquareClient } from "./square-client.js";

// A store-resolution failure the routes translate to HTTP. Distinct from
// SquareConnectError (an upstream Square failure) — this is about OUR row: the
// PosStore is missing, or it isn't a Square store.
export class SquareStoreError extends Error {
  constructor(readonly kind: "not_found" | "not_square") {
    super(`square store error: ${kind}`);
    this.name = "SquareStoreError";
  }
}

// The synthetic PosStore PK is `square:{location_id}`; the bare location id is
// what Square's catalog uses for location overrides + presence. We read it off
// the row's `providerStoreId` when present and fall back to stripping the prefix.
const SQUARE_POS_STORE_PREFIX = "square:";

export function squareLocationIdFromPosStoreId(posStoreId: string): string {
  return posStoreId.startsWith(SQUARE_POS_STORE_PREFIX)
    ? posStoreId.slice(SQUARE_POS_STORE_PREFIX.length)
    : posStoreId;
}

function toSquareEnvironment(environment: IntegrationEnvironment | null): SquareEnvironment {
  // wireToDbEnvironment maps sandbox→STAGING / production→PRODUCTION; reverse it.
  return environment === IntegrationEnvironment.PRODUCTION ? "production" : "sandbox";
}

export interface SquareStoreCredentials {
  token: string;
  environment: SquareEnvironment;
  locationId: string;
}

// Resolve a Square store's credential + bound location. The token is read through
// the canonical resolvePosAccessToken seam (encrypted dual-read, #750) — never
// the plaintext column. Throws SquareStoreError for a missing / non-Square row.
// Shared by the catalog read AND the order sync (Phase 3).
export async function resolveSquareStoreCredentials(
  prisma: PrismaClient,
  posStoreId: string,
): Promise<SquareStoreCredentials> {
  // Existence + the bound location id (one indexed PK read). The credential
  // itself comes from resolvePosAccessToken below, not this row.
  const row = await prisma.cloverMerchant.findUnique({
    where: { id: posStoreId },
    select: { id: true, providerStoreId: true },
  });
  if (!row) {
    throw new SquareStoreError("not_found");
  }

  const { token, provider, environment } = await resolvePosAccessToken(prisma, posStoreId);
  if (provider !== OrderProvider.SQUARE) {
    throw new SquareStoreError("not_square");
  }

  return {
    token,
    environment: toSquareEnvironment(environment),
    locationId: row.providerStoreId ?? squareLocationIdFromPosStoreId(posStoreId),
  };
}

// Resolve credentials and page the store's live catalog. Throws SquareStoreError
// for a missing / non-Square row; fetchCatalog throws SquareConnectError upstream.
export async function fetchSquareStoreCatalog(
  prisma: PrismaClient,
  square: SquareClient,
  posStoreId: string,
): Promise<{ objects: SquareCatalogObject[]; locationId: string }> {
  const { token, environment, locationId } = await resolveSquareStoreCredentials(prisma, posStoreId);
  const objects = await square.fetchCatalog(token, environment);
  return { objects, locationId };
}

// The menu read path (provider-aware loadMenu, Square branch).
export async function loadSquareMenu(
  prisma: PrismaClient,
  square: SquareClient,
  posStoreId: string,
): Promise<OrderMenuResponse> {
  const { objects, locationId } = await fetchSquareStoreCatalog(prisma, square, posStoreId);
  return normalizeSquareCatalog(objects, locationId);
}

// The catalog-import path: same fetch, returns counts ("imported N items").
export async function importSquareCatalog(
  prisma: PrismaClient,
  square: SquareClient,
  posStoreId: string,
): Promise<SquareCatalogCounts> {
  const { objects, locationId } = await fetchSquareStoreCatalog(prisma, square, posStoreId);
  return summarizeSquareCatalog(objects, locationId).counts;
}
