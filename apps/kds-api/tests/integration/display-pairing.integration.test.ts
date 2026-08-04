import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPairingClaim } from "../../src/lib/device-pairing.js";
import { DEVICE_TOKEN_COOKIE_NAME } from "../../src/lib/kds-auth.js";
import { startKdsHttpItContext, type KdsHttpItContext } from "./fixture.js";

// The customer "order-ready" display surface (/api/display/tickets) staged on
// MULTITENANT_MODE (resolveDisplayMerchant). This is the security half of display
// pairing: `off` keeps the public ?merchantId= kiosk path byte-for-byte, while
// `enforce` requires the paired DISPLAY device token (riding the same-origin
// cookie) and rejects a mismatched store — closing the untrusted-param IDOR that
// Phase 2c hardened on the board side. Run over real Postgres + Redis so the
// real device-auth + GETDEL redeem path is exercised, not a mock.
describe("display pairing — MULTITENANT_MODE=enforce gating (real Postgres + Redis)", () => {
  let ctx: KdsHttpItContext;

  beforeAll(async () => {
    ctx = await startKdsHttpItContext({ multiTenantMode: "enforce" });
    await ctx.services.prisma.cloverMerchant.createMany({
      data: ["m_disp_a", "m_disp_b"].map((id) => ({ id }))
    });
  });

  afterAll(async () => {
    await ctx?.stop();
  });

  // Pair a DISPLAY-role device and return its same-origin cookie — exactly what
  // the browser replays on the next /api/display/* call and the /ws/display handshake.
  async function pairDisplayCookie(merchantId: string): Promise<string> {
    const claim = await createPairingClaim(ctx.services, { merchantId, label: "Lobby", role: "DISPLAY" });
    const res = await ctx.app.inject({ method: "POST", url: "/api/pair/redeem", payload: { code: claim.claimCode } });
    const raw = res.headers["set-cookie"];
    const cookies = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
    const hit = cookies.find((c) => c.startsWith(`${DEVICE_TOKEN_COOKIE_NAME}=`));
    if (!hit) throw new Error("no device cookie on redeem response");
    return hit.split(";")[0];
  }

  it("rejects an unpaired display 401 — the bare ?merchantId= is no longer trusted under enforce", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/api/display/tickets?merchantId=m_disp_a" });
    expect(res.statusCode).toBe(401);
  });

  it("serves the paired display's bound store via the same-origin cookie → 200", async () => {
    const cookie = await pairDisplayCookie("m_disp_a");
    const res = await ctx.app.inject({ method: "GET", url: "/api/display/tickets", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().merchantId).toBe("m_disp_a");
  });

  it("rejects a cross-store ?merchantId= from a paired display 403 (IDOR guard)", async () => {
    const cookie = await pairDisplayCookie("m_disp_a");
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/display/tickets?merchantId=m_disp_b",
      headers: { cookie }
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("display pairing — MULTITENANT_MODE=off keeps the public kiosk path (real Postgres + Redis)", () => {
  let ctx: KdsHttpItContext;

  beforeAll(async () => {
    ctx = await startKdsHttpItContext(); // off (default)
    await ctx.services.prisma.cloverMerchant.create({ data: { id: "m_disp_pub" } });
  });

  afterAll(async () => {
    await ctx?.stop();
  });

  it("serves a public ?merchantId= snapshot with no token → 200 (byte-for-byte legacy behavior)", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/api/display/tickets?merchantId=m_disp_pub" });
    expect(res.statusCode).toBe(200);
    expect(res.json().merchantId).toBe("m_disp_pub");
  });
});
