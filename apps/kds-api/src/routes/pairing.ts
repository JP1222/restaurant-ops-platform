import type { FastifyInstance } from "fastify";

import { KdsPairRedeemRequestSchema } from "@rop/contracts";

import { redeemPairingClaim } from "../lib/device-pairing.js";
import { DEVICE_TOKEN_COOKIE_NAME, getDeviceCookieOptions } from "../lib/kds-auth.js";
import type { AppServices } from "../lib/services.js";

// Light per-IP cap on redeem attempts. The claim space (8 Crockford-base32 chars
// ≈ 10^12) + the short TTL already make brute-force impractical; this is hygiene.
const REDEEM_RATE_LIMIT = 20;
const REDEEM_RATE_WINDOW_SECONDS = 300;

async function tooManyRedeems(services: AppServices, ip: string): Promise<boolean> {
  const key = `pairredeem-rate:${ip}`;
  const n = await services.redisPublisher.incr(key);
  if (n === 1) {
    await services.redisPublisher.expire(key, REDEEM_RATE_WINDOW_SECONDS);
  }
  return n > REDEEM_RATE_LIMIT;
}

// Device pairing (ADR-0818 Phase-2b). PUBLIC + unauthenticated by design — the
// one-time claim code IS the credential. Registered OUTSIDE the `/api/kds/*` auth
// preHandler (different path prefix), so the device can redeem before it holds any
// token. The redeem mints the durable device token; the kds-web BFF persists it.
export async function registerPairingRoutes(app: FastifyInstance, services: AppServices) {
  app.post("/api/pair/redeem", async (request, reply) => {
    if (await tooManyRedeems(services, request.ip)) {
      reply.code(429);
      return { ok: false as const, reason: "invalid_or_expired" as const };
    }

    const parsed = KdsPairRedeemRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false as const, reason: "invalid_or_expired" as const };
    }

    const result = await redeemPairingClaim(services, parsed.data.code);
    if (!result.ok) {
      reply.code(410); // Gone — claim consumed or expired
      return { ok: false as const, reason: "invalid_or_expired" as const };
    }

    // Same-origin durable pairing: set the device token as an HttpOnly cookie so
    // every subsequent board→kds-api HTTP call + the WS handshake carry it. The
    // token is also returned in the body (the kds-web /pair page reads `role` to
    // redirect; it relies on the cookie, not the body, for auth).
    reply.setCookie(DEVICE_TOKEN_COOKIE_NAME, result.token, getDeviceCookieOptions(services.config));

    return {
      ok: true as const,
      token: result.token,
      merchantId: result.merchantId,
      role: result.role
    };
  });
}
