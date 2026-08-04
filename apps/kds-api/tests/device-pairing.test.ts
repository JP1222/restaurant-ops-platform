import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  claimRedisKey,
  createPairingClaim,
  generateClaimCode,
  redeemPairingClaim,
  resolveTenantIdForMerchant
} from "../src/lib/device-pairing.js";

const CROCKFORD = "[0-9ABCDEFGHJKMNPQRSTVWXYZ]";

function mockServices(over: {
  merchantTenant?: string | null | undefined; // undefined => merchant not found
  getdel?: unknown;
  kdsWebBaseUrl?: string;
} = {}) {
  const set = vi.fn(async () => "OK");
  const getdel = vi.fn(async () => over.getdel ?? null);
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "dev-1",
    merchantId: data.merchantId,
    role: data.role
  }));
  return {
    services: {
      prisma: {
        cloverMerchant: {
          findUnique: vi.fn(async () =>
            over.merchantTenant === undefined ? null : { tenantId: over.merchantTenant }
          )
        },
        kdsDeviceToken: { create }
      },
      redisPublisher: { set, getdel, incr: vi.fn(), expire: vi.fn() },
      config: {
        pairClaimTtlSeconds: 600,
        appBaseUrl: "https://kds.example.test",
        kdsWebBaseUrl: over.kdsWebBaseUrl
      }
    } as never,
    set,
    getdel,
    create
  };
}

beforeEach(() => vi.clearAllMocks());

describe("generateClaimCode / claimRedisKey", () => {
  it("emits a grouped 8-char Crockford-base32 code", () => {
    const code = generateClaimCode();
    expect(code).toMatch(new RegExp(`^${CROCKFORD}{4}-${CROCKFORD}{4}$`));
    expect(code).not.toMatch(/[ILOU]/); // ambiguous chars excluded
  });

  it("normalizes a hand-typed code to the canonical Redis key", () => {
    expect(claimRedisKey("k7q2-9f3m")).toBe("kdspair:K7Q29F3M");
    expect(claimRedisKey("K7Q2 9F3M")).toBe("kdspair:K7Q29F3M");
  });
});

describe("resolveTenantIdForMerchant", () => {
  it("uses the merchant's tenant", async () => {
    const { services } = mockServices({ merchantTenant: "tenant-A" });
    expect(await resolveTenantIdForMerchant(services.prisma, "M1")).toBe("tenant-A");
  });
  it("falls back to the default tenant for a null or unknown merchant", async () => {
    const nullTenant = mockServices({ merchantTenant: null });
    expect(await resolveTenantIdForMerchant(nullTenant.services.prisma, "M1")).toBe("tenant-default");
    const unknown = mockServices({ merchantTenant: undefined });
    expect(await resolveTenantIdForMerchant(unknown.services.prisma, "M1")).toBe("tenant-default");
  });
});

describe("createPairingClaim", () => {
  it("writes a TTL'd Redis claim and returns a pairUrl carrying the code", async () => {
    const { services, set } = mockServices({ merchantTenant: "tenant-A" });
    const out = await createPairingClaim(services, { merchantId: "M1", label: "Line 1", role: "KDS" });

    expect(out.role).toBe("KDS");
    expect(out.label).toBe("Line 1");
    expect(out.expiresInSeconds).toBe(600);
    expect(out.pairUrl).toBe(`https://kds.example.test/pair?code=${encodeURIComponent(out.claimCode)}`);

    // SET <kdspair:CODE> <envelope> EX 600
    expect(set).toHaveBeenCalledWith(claimRedisKey(out.claimCode), expect.any(String), "EX", 600);
    const envelope = JSON.parse(set.mock.calls[0]![1] as string);
    expect(envelope).toEqual({ merchantId: "M1", label: "Line 1", role: "KDS", tenantId: "tenant-A" });
  });

  it("prefers kdsWebBaseUrl over appBaseUrl for the link", async () => {
    const { services } = mockServices({ merchantTenant: "tenant-A", kdsWebBaseUrl: "https://floor.example/" });
    const out = await createPairingClaim(services, { merchantId: "M1", label: "Display", role: "DISPLAY" });
    expect(out.pairUrl).toMatch(/^https:\/\/floor\.example\/pair\?code=/); // trailing slash trimmed
  });
});

describe("redeemPairingClaim", () => {
  it("mints a durable yrkds_ token + creates the device row on a valid code", async () => {
    const envelope = JSON.stringify({ merchantId: "M1", label: "Line 1", role: "KDS", tenantId: "tenant-A" });
    const { services, create } = mockServices({ getdel: envelope });

    const result = await redeemPairingClaim(services, "K7Q2-9F3M");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.token).toMatch(/^yrkds_/);
      expect(result.merchantId).toBe("M1");
      expect(result.role).toBe("KDS");
    }
    // Row created with the envelope's role + tenant + a hash (never null).
    const data = create.mock.calls[0]![0].data;
    expect(data).toMatchObject({ merchantId: "M1", label: "Line 1", role: "KDS", tenantId: "tenant-A" });
    expect(typeof data.tokenHash).toBe("string");
  });

  it("fails closed when the code is missing/expired (GETDEL → null)", async () => {
    const { services, create } = mockServices({ getdel: null });
    const result = await redeemPairingClaim(services, "NOPE-NOPE");
    expect(result).toEqual({ ok: false, reason: "invalid_or_expired" });
    expect(create).not.toHaveBeenCalled();
  });
});
