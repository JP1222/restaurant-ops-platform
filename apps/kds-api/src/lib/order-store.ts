import { OrderProvider } from "@rop/db-kds";
import type { FastifyBaseLogger } from "fastify";

import type { AppConfig } from "../config.js";
import { resolveDefaultCloverMerchantId, type CloverMerchantLookup } from "./clover-runtime.js";

// The POS provider backing a resolved store, narrowed to the two the ordering
// surface can serve a menu for. A store's provider comes from its bound
// PosAccount; a legacy Clover row with no PosAccount (pre-#739 split) is Clover
// by construction.
export type OrderStoreProvider = "clover" | "square";

// A bound per-store row: its id (the partition key / "merchantId"), plus the
// provider read off its PosAccount when one is linked.
type BoundMerchant = { id: string; posAccount: { provider: OrderProvider } | null };

// Narrow structural slice of PrismaClient this module needs — keeps the resolver
// unit-testable with a tiny mock (mirrors clover-runtime's CloverMerchantLookup).
// `resolveDefaultCloverMerchantId` needs the CloverMerchant + providerAppState
// surface; the explicit-store path additionally needs `location`.
export type OrderStoreLookup = CloverMerchantLookup & {
  location: {
    findFirst(args: {
      where: { id: string; active: true };
      select: {
        id: true;
        // take: 2, not 1 — we only need to tell "exactly one" from "more than
        // one" bound merchant. The 2nd row is the ambiguity sentinel (see the
        // guard in resolveOrderStore); loading all bindings would be wasteful.
        cloverMerchants: {
          select: { id: true; posAccount: { select: { provider: true } } };
          orderBy: { updatedAt: "desc" };
          take: 2;
        };
      };
    }): Promise<{ id: string; cloverMerchants: BoundMerchant[] } | null>;
  };
};

export interface ResolvedOrderStore {
  merchantId: string;
  /** The explicitly-selected store, or null on the default single-store path. */
  locationId: string | null;
  /** Which POS the menu / pricing path must dispatch to (Iron Law: branch, don't 502). */
  provider: OrderStoreProvider;
}

/**
 * Resolve the store (Clover merchant) for a PUBLIC online order.
 *
 * - `requestedLocationId` present → it MUST be an ACTIVE Location with a bound
 *   merchant. Unlike `resolveDefaultCloverMerchantId`'s `requested` (an internal,
 *   trusted merchant id), a public caller's string is NEVER trusted as a merchant
 *   id — an unknown / inactive / unbound store resolves to `null` so the route
 *   refuses rather than silently charging the default store (pay A, order B).
 * - absent → the default merchant (today's single-store behavior). `locationId`
 *   is `null`, which leaves the checkout payment gate on the legacy path untouched.
 *
 * Returns `null` when nothing resolves (no merchant configured, a bad store, or
 * an AMBIGUOUS store with more than one bound merchant — see the guard below).
 */
export async function resolveOrderStore(
  prisma: OrderStoreLookup,
  config: AppConfig,
  requestedLocationId: string | undefined,
  log: FastifyBaseLogger,
): Promise<ResolvedOrderStore | null> {
  if (requestedLocationId) {
    const location = await prisma.location.findFirst({
      where: { id: requestedLocationId, active: true },
      select: {
        id: true,
        cloverMerchants: {
          select: { id: true, posAccount: { select: { provider: true } } },
          orderBy: { updatedAt: "desc" },
          take: 2,
        },
      },
    });
    if (!location || location.cloverMerchants.length === 0) {
      // Unknown / inactive store, or a store with no POS binding yet.
      return null;
    }

    // Ambiguity guard. A Location MUST resolve to exactly one merchant: that
    // merchant id selects the menu, the pricing, AND the Clover charge. With >1
    // bound merchant the old `take: 1` quietly routed the customer's money to
    // whichever row was updated last. Fail CLOSED instead — warn loudly (naming
    // the location and the candidates, `merchantIds[0]` being the store the old
    // code would have wrongly charged) and refuse, so the route returns a clean
    // 404/503 rather than charging an arbitrary store. The DB partial unique
    // index (migration 20260616_clover_merchant_location_unique) normally makes
    // this unreachable; this is defense in depth for legacy rows / a dropped
    // constraint.
    if (location.cloverMerchants.length > 1) {
      log.warn(
        {
          locationId: location.id,
          merchantIds: location.cloverMerchants.map((merchant) => merchant.id),
        },
        "order: location has multiple bound merchants — refusing to route ambiguously",
      );
      return null;
    }

    const bound = location.cloverMerchants[0];
    if (!bound) {
      return null;
    }
    return {
      merchantId: bound.id,
      locationId: location.id,
      provider: bound.posAccount?.provider === OrderProvider.SQUARE ? "square" : "clover",
    };
  }

  // Default single-store path: always the configured Clover merchant (a Square
  // store is only ever reached via an explicit ?location=, never the default).
  const merchantId = await resolveDefaultCloverMerchantId(prisma, config, undefined);
  return merchantId ? { merchantId, locationId: null, provider: "clover" } : null;
}
