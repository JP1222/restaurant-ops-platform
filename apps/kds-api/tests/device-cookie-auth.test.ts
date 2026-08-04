import { describe, expect, it, vi } from "vitest";

import {
  authenticateKdsRequest,
  DEVICE_TOKEN_COOKIE_NAME,
  getDeviceCookieOptions
} from "../src/lib/kds-auth.js";

// Minimal services: no session, and the device-token lookup returns `rec` (the
// hash match is exercised by the real findFirst in integration — here we assert
// the cookie/bearer EXTRACTION + context shape).
function mockServices(rec: { id: string; merchantId: string; tenantId: string | null } | null) {
  return {
    auth: { readSession: vi.fn(async () => null), getAccountById: vi.fn(async () => null) },
    prisma: {
      kdsDeviceToken: {
        findFirst: vi.fn(async () => rec),
        update: vi.fn(async () => ({}))
      }
    }
  } as never;
}

function req(opts: { cookies?: Record<string, string>; headers?: Record<string, string> } = {}) {
  return { cookies: opts.cookies ?? {}, headers: opts.headers ?? {} } as never;
}

describe("authenticateKdsRequest — device cookie (Phase 2b)", () => {
  const rec = { id: "d1", merchantId: "M1", tenantId: "tenant-A" };

  it("authenticates a device by the yr_device_token cookie (no bearer)", async () => {
    const result = await authenticateKdsRequest(
      mockServices(rec),
      req({ cookies: { [DEVICE_TOKEN_COOKIE_NAME]: "yrkds_abc" } })
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context).toMatchObject({ type: "device", merchantId: "M1", tenantId: "tenant-A" });
    }
  });

  it("still authenticates a device by the Bearer header", async () => {
    const result = await authenticateKdsRequest(
      mockServices(rec),
      req({ headers: { authorization: "Bearer yrkds_xyz" } })
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context).toMatchObject({ type: "device", merchantId: "M1" });
    }
  });

  it("rejects when no session, bearer, OR device cookie is present", async () => {
    const result = await authenticateKdsRequest(mockServices(null), req());
    expect(result).toEqual({ ok: false });
  });
});

describe("getDeviceCookieOptions", () => {
  it("is HttpOnly + lax + secure on https + long-lived", () => {
    const opts = getDeviceCookieOptions({ appBaseUrl: "https://kds.example" } as never);
    expect(opts).toMatchObject({ path: "/", httpOnly: true, sameSite: "lax", secure: true });
    expect(opts.maxAge).toBeGreaterThan(60 * 60 * 24 * 365); // > 1 year (durable)
  });

  it("is not secure on http (local dev)", () => {
    expect(getDeviceCookieOptions({ appBaseUrl: "http://localhost:3000" } as never).secure).toBe(false);
  });
});
