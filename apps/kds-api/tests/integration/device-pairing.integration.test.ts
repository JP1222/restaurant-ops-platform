import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPairingClaim } from "../../src/lib/device-pairing.js";
import { DEVICE_TOKEN_COOKIE_NAME } from "../../src/lib/kds-auth.js";
import { startKdsHttpItContext, type KdsHttpItContext } from "./fixture.js";

// The full device-pairing handshake over real Postgres + Redis, end to end:
// mint a one-time claim (Redis) -> redeem it via the PUBLIC route (atomic GETDEL
// -> mints a durable KdsDeviceToken + sets the same-origin cookie) -> prove the
// token authorizes a store-scoped /api/kds request by BOTH bearer and cookie, and
// that the IDOR / revoke / replay guards fire. The unit tests mock Prisma + Redis;
// this is the only place the real GETDEL one-time semantics and the real
// device-auth preHandler (resolveKdsRequestMerchant) run together — i.e. the
// security contract the deployed board pairing actually relies on.
describe("device pairing integration (handshake over real Postgres + Redis)", () => {
  let ctx: KdsHttpItContext;

  beforeAll(async () => {
    ctx = await startKdsHttpItContext();
    // A device row FK-references CloverMerchant (you only pair for a real store),
    // so seed the stores we pair. The cross-merchant *target* (m_pair_other) is
    // deliberately NOT seeded — its 403 must fire on the access check, before any
    // resolution or write touches it.
    await ctx.services.prisma.cloverMerchant.createMany({
      data: ["m_pair_happy", "m_pair_auth", "m_pair_owner", "m_pair_revoke", "m_pair_replay"].map((id) => ({ id }))
    });
  });

  afterAll(async () => {
    await ctx?.stop();
  });

  // Mint a claim (lib call — no admin token needed) then redeem it via the public
  // HTTP route, exactly as a freshly-opened /pair page does.
  async function pairDevice(
    merchantId: string,
    role: "KDS" | "DISPLAY" = "KDS"
  ): Promise<LightMyRequestResponse> {
    const claim = await createPairingClaim(ctx.services, { merchantId, label: "Pad", role });
    return ctx.app.inject({ method: "POST", url: "/api/pair/redeem", payload: { code: claim.claimCode } });
  }

  // Pull the `yr_device_token=<value>` pair out of a Set-Cookie header and replay
  // it as a request cookie — i.e. what the browser sends back on the next call.
  function deviceCookie(res: LightMyRequestResponse): string {
    const raw = res.headers["set-cookie"];
    const cookies = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
    const hit = cookies.find((c) => c.startsWith(`${DEVICE_TOKEN_COOKIE_NAME}=`));
    if (!hit) throw new Error("no device cookie on redeem response");
    return hit.split(";")[0];
  }

  it("redeems a claim → 200, mints a durable token, sets the same-origin HttpOnly cookie, creates the row", async () => {
    const res = await pairDevice("m_pair_happy");
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body).toMatchObject({ ok: true, merchantId: "m_pair_happy", role: "KDS" });
    expect(typeof body.token).toBe("string");
    expect(body.token.startsWith("yrkds")).toBe(true);

    // Same-origin cookie transport (PR-3): HttpOnly so JS can't read it.
    const cookieHeader = res.headers["set-cookie"];
    const cookieStr = Array.isArray(cookieHeader) ? cookieHeader.join(";") : String(cookieHeader ?? "");
    expect(cookieStr).toContain(`${DEVICE_TOKEN_COOKIE_NAME}=`);
    expect(cookieStr.toLowerCase()).toContain("httponly");

    // Durable row: not revoked, role + tenant stamped (the tenant stamp is what
    // keeps a flip to MULTITENANT_MODE=enforce from rejecting already-paired devices).
    const row = await ctx.services.prisma.kdsDeviceToken.findFirst({ where: { merchantId: "m_pair_happy" } });
    expect(row).not.toBeNull();
    expect(row?.revokedAt).toBeNull();
    expect(row?.role).toBe("KDS");
    expect(row?.tenantId).toBe("tenant-default");
  });

  it("the minted token authorizes a store-scoped /api/kds request — by bearer AND by the same-origin cookie", async () => {
    const res = await pairDevice("m_pair_auth");
    const token = res.json().token as string;

    const byBearer = await ctx.app.inject({
      method: "GET",
      url: "/api/kds/tickets",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(byBearer.statusCode).toBe(200);

    const byCookie = await ctx.app.inject({
      method: "GET",
      url: "/api/kds/tickets",
      headers: { cookie: deviceCookie(res) }
    });
    expect(byCookie.statusCode).toBe(200);
  });

  it("rejects a cross-merchant request 403 (the IDOR a bare ?merchantId= would otherwise open)", async () => {
    const res = await pairDevice("m_pair_owner");
    const token = res.json().token as string;

    const cross = await ctx.app.inject({
      method: "GET",
      url: "/api/kds/tickets?merchantId=m_pair_other",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(cross.statusCode).toBe(403);
  });

  it("rejects a revoked device 401", async () => {
    const res = await pairDevice("m_pair_revoke");
    const token = res.json().token as string;

    const before = await ctx.app.inject({
      method: "GET",
      url: "/api/kds/tickets",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(before.statusCode).toBe(200);

    await ctx.services.prisma.kdsDeviceToken.updateMany({
      where: { merchantId: "m_pair_revoke" },
      data: { revokedAt: new Date() }
    });

    const after = await ctx.app.inject({
      method: "GET",
      url: "/api/kds/tickets",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(after.statusCode).toBe(401);
  });

  it("is one-time: replaying a consumed claim code → 410 invalid_or_expired", async () => {
    const claim = await createPairingClaim(ctx.services, { merchantId: "m_pair_replay", label: "Pad", role: "KDS" });

    const first = await ctx.app.inject({ method: "POST", url: "/api/pair/redeem", payload: { code: claim.claimCode } });
    expect(first.statusCode).toBe(200);

    const second = await ctx.app.inject({ method: "POST", url: "/api/pair/redeem", payload: { code: claim.claimCode } });
    expect(second.statusCode).toBe(410);
    expect(second.json()).toMatchObject({ ok: false, reason: "invalid_or_expired" });
  });

  it("rejects an unknown code → 410 invalid_or_expired", async () => {
    const res = await ctx.app.inject({ method: "POST", url: "/api/pair/redeem", payload: { code: "ZZZZ-ZZZZ" } });
    expect(res.statusCode).toBe(410);
    expect(res.json()).toMatchObject({ ok: false, reason: "invalid_or_expired" });
  });
});
