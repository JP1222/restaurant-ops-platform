import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import { resolveOrderStore, type OrderStoreLookup } from "../src/lib/order-store.js";

const CONFIG = {
  cloverBaseUrl: "https://api.clover.com",
  cloverRegion: "US",
  cloverMerchantId: "M1",
  cloverToken: "tok",
} as unknown as AppConfig;

type BoundMerchant = { id: string; posAccount?: { provider: "CLOVER" | "SQUARE" } | null };

function makePrisma(
  over: {
    location?: { id: string; cloverMerchants: BoundMerchant[] } | null;
    defaultMerchant?: { id: string } | null;
  } = {},
): OrderStoreLookup {
  return {
    providerAppState: { findUnique: vi.fn().mockResolvedValue(null) },
    cloverMerchant: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(over.defaultMerchant ?? null),
    },
    location: { findFirst: vi.fn().mockResolvedValue(over.location ?? null) },
  } as unknown as OrderStoreLookup;
}

// A logger stub exposing the one method the resolver uses (warn) plus the spies
// a test asserts on. Cast through unknown like the prisma mock — we only model
// the slice the code touches, not the full pino surface.
function makeLog(): FastifyBaseLogger & { warn: ReturnType<typeof vi.fn> } {
  return {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  } as unknown as FastifyBaseLogger & { warn: ReturnType<typeof vi.fn> };
}

describe("resolveOrderStore", () => {
  it("falls back to the configured default merchant when no store is requested", async () => {
    const store = await resolveOrderStore(makePrisma(), CONFIG, undefined, makeLog());
    expect(store).toEqual({ merchantId: "M1", locationId: null, provider: "clover" });
  });

  it("returns null when no store is requested and nothing is configured", async () => {
    const cfg = {
      ...CONFIG,
      cloverMerchantId: undefined,
      cloverToken: undefined,
    } as unknown as AppConfig;
    const store = await resolveOrderStore(makePrisma(), cfg, undefined, makeLog());
    expect(store).toBeNull();
  });

  it("resolves a requested active store to its bound merchant (Clover provider)", async () => {
    const prisma = makePrisma({ location: { id: "loc2", cloverMerchants: [{ id: "M2" }] } });
    const log = makeLog();
    const store = await resolveOrderStore(prisma, CONFIG, "loc2", log);
    expect(store).toEqual({ merchantId: "M2", locationId: "loc2", provider: "clover" });
    // The unambiguous (exactly-one-binding) path must stay quiet — a warn here
    // would be noise that desensitizes operators to the real ambiguity signal.
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("reports provider 'square' when the bound store's PosAccount is Square", async () => {
    const prisma = makePrisma({
      location: { id: "loc-sq", cloverMerchants: [{ id: "square:LOC1", posAccount: { provider: "SQUARE" } }] },
    });
    const store = await resolveOrderStore(prisma, CONFIG, "loc-sq", makeLog());
    expect(store).toEqual({ merchantId: "square:LOC1", locationId: "loc-sq", provider: "square" });
  });

  it("reports provider 'clover' for a legacy bound row with no PosAccount", async () => {
    const prisma = makePrisma({
      location: { id: "loc-legacy", cloverMerchants: [{ id: "M9", posAccount: null }] },
    });
    const store = await resolveOrderStore(prisma, CONFIG, "loc-legacy", makeLog());
    expect(store).toEqual({ merchantId: "M9", locationId: "loc-legacy", provider: "clover" });
  });

  it("returns null for an unknown / inactive store — never silently uses the default", async () => {
    // location.findFirst → null (no active row). Even though a default merchant
    // exists, an explicitly-requested-but-unresolvable store must NOT fall back.
    const prisma = makePrisma({ location: null, defaultMerchant: { id: "M1" } });
    const store = await resolveOrderStore(prisma, CONFIG, "ghost", makeLog());
    expect(store).toBeNull();
  });

  it("returns null for a store that exists but has no bound merchant", async () => {
    const prisma = makePrisma({ location: { id: "loc3", cloverMerchants: [] } });
    const store = await resolveOrderStore(prisma, CONFIG, "loc3", makeLog());
    expect(store).toBeNull();
  });

  it("returns null and warns when a location has more than one bound merchant", async () => {
    // The ambiguity case (data the DB partial unique index now forbids, but the
    // resolver still fails closed on). >1 bound merchant must NOT silently route
    // the order's menu / pricing / charge to whichever was updated last.
    const prisma = makePrisma({
      location: { id: "loc4", cloverMerchants: [{ id: "M4" }, { id: "M5" }] },
    });
    const log = makeLog();

    const store = await resolveOrderStore(prisma, CONFIG, "loc4", log);

    expect(store).toBeNull();
    // The signal that makes the formerly-silent failure loud: a structured warn
    // naming the offending location and the candidate merchants the operator
    // must disambiguate. Message wording is the implementer's call; the fields
    // are the contract.
    expect(log.warn).toHaveBeenCalledTimes(1);
    const [payload, message] = log.warn.mock.calls[0] ?? [];
    expect(payload).toMatchObject({ locationId: "loc4", merchantIds: ["M4", "M5"] });
    expect(typeof message).toBe("string");
    expect(message).not.toHaveLength(0);
  });
});
