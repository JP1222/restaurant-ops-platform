import { createHash, randomBytes } from "node:crypto";
import { DEFAULT_TENANT_ID } from "@rop/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../config.js";
import { resolveDefaultCloverMerchantId } from "./clover-runtime.js";
import type { AppServices } from "./services.js";
import { WEB_SESSION_COOKIE_NAME } from "./web-auth.js";

const DEVICE_TOKEN_PREFIX = "yrkds";

// Device pairing (ADR-0818 Phase-2b): a paired device carries its durable token
// in this cookie. kds-web and kds-api are SAME-ORIGIN in prod (Traefik routes
// /api + /ws to kds-api and the rest to kds-web — compose/kds.yml), so this
// cookie is sent on every board→kds-api HTTP call AND the WS handshake — no
// bearer threading or `?token=` needed. HttpOnly so board JS can't read it.
export const DEVICE_TOKEN_COOKIE_NAME = "yr_device_token";
// ~10 years. The token has NO server-side expiry (revoke-only); the long maxAge
// just keeps the device paired across reboots. Only a manager revoke (or a
// cookie wipe) un-pairs it.
const DEVICE_COOKIE_MAX_AGE_SECONDS = 10 * 365 * 24 * 60 * 60;

export function getDeviceCookieOptions(config: AppConfig) {
  return {
    path: "/" as const,
    httpOnly: true as const,
    sameSite: "lax" as const,
    secure: new URL(config.appBaseUrl).protocol === "https:",
    maxAge: DEVICE_COOKIE_MAX_AGE_SECONDS
  };
}

// A minimal structured-logger shape (Fastify's request.log satisfies it). Passed
// in for the Phase-2c tenant-parity log so kds-auth stays logger-agnostic.
type ParityLogger = { warn: (obj: unknown, msg?: string) => void };

function firstHeaderValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function expectedOrigin(appBaseUrl: string) {
  return new URL(appBaseUrl).origin;
}

type HeaderRequest = Pick<FastifyRequest, "headers">;

export function isTrustedWriteOrigin(request: HeaderRequest, appBaseUrl: string) {
  const expected = expectedOrigin(appBaseUrl);
  const origin = firstHeaderValue(request.headers.origin);
  if (origin) {
    return { ok: origin === expected, expected };
  }

  const referer = firstHeaderValue(request.headers.referer);
  if (!referer) {
    return { ok: false, expected };
  }

  try {
    return { ok: new URL(referer).origin === expected, expected };
  } catch {
    return { ok: false, expected };
  }
}

export function hashDeviceToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function createDeviceToken() {
  const raw = `${DEVICE_TOKEN_PREFIX}_${randomBytes(24).toString("base64url")}`;
  return {
    token: raw,
    tokenHash: hashDeviceToken(raw)
  };
}

function bearerToken(request: HeaderRequest) {
  const header = firstHeaderValue(request.headers.authorization);
  if (!header) {
    return null;
  }

  const [scheme, token] = header.split(" ", 2);
  if (!scheme || !token || scheme.toLowerCase() !== "bearer") {
    return null;
  }

  return token.trim();
}

export type KdsAuthContext = {
  type: "session" | "device";
  merchantId?: string;
  // Multi-tenant (ADR-0818, Phase 2): the principal's tenant — for a session the
  // tenant the account logged into (from the session claim, packages/auth Phase
  // 2b); for a device the tenant its token is bound to (KdsDeviceToken.tenantId,
  // which may be null on a pre-backfill token → undefined here). Consumed by
  // resolveKdsMerchantId only when multiTenantMode != "off".
  tenantId?: string | undefined;
};

export async function authenticateKdsRequest(services: AppServices, request: FastifyRequest) {
  const sessionId = request.cookies[WEB_SESSION_COOKIE_NAME];
  if (sessionId) {
    const session = await services.auth.readSession(sessionId);
    if (session && (await services.auth.getAccountById(session.accountId))) {
      return {
        ok: true,
        context: { type: "session", tenantId: session.tenantId } satisfies KdsAuthContext
      };
    }
  }

  // A device authenticates with its token presented EITHER as a Bearer header
  // (internal callers) OR the same-origin device cookie (a paired board/display,
  // set at pairing redeem). Same lookup either way.
  const token = bearerToken(request) ?? request.cookies[DEVICE_TOKEN_COOKIE_NAME];
  if (!token) {
    return { ok: false as const };
  }

  const tokenRecord = await services.prisma.kdsDeviceToken.findFirst({
    where: {
      tokenHash: hashDeviceToken(token),
      revokedAt: null
    },
    select: {
      id: true,
      merchantId: true,
      tenantId: true
    }
  });

  if (!tokenRecord) {
    return { ok: false as const };
  }

  await services.prisma.kdsDeviceToken.update({
    where: { id: tokenRecord.id },
    data: { lastUsedAt: new Date() }
  });

  return {
    ok: true as const,
    context: {
      type: "device",
      merchantId: tokenRecord.merchantId,
      tenantId: tokenRecord.tenantId ?? undefined
    } satisfies KdsAuthContext
  };
}

export function rejectUnauthorized(reply: FastifyReply) {
  reply.code(401);
  return { error: "Unauthorized" };
}

export function resolveRequestedMerchantId(request: FastifyRequest) {
  const query = request.query;
  if (typeof query !== "object" || query === null || !("merchantId" in query)) {
    return undefined;
  }

  const merchantId = (query as { merchantId?: unknown }).merchantId;
  return typeof merchantId === "string" ? merchantId : undefined;
}

export function ensureDeviceMerchantAccess(
  auth: KdsAuthContext,
  requestedMerchantId: string | undefined,
  resolvedMerchantId: string | null,
  reply: FastifyReply
) {
  if (auth.type !== "device") {
    return true;
  }

  const targetMerchantId = requestedMerchantId ?? resolvedMerchantId ?? null;
  if (!targetMerchantId || auth.merchantId !== targetMerchantId) {
    reply.code(403);
    return false;
  }

  return true;
}

// Resolve the store a KDS request operates on (ADR-0018 Phase 5; ADR-0818 Phase 2c).
//
// SECURITY (audit-2026-06-03 #470/#471/#472/#473): the resolved store is the
// authorization boundary for every /api/kds/* read AND write (it is what
// `assertTicketOwnership` checks ticket ownership against). It must never be
// taken from an attacker-controlled input for a caller with no proven claim.
//
// There are two resolution paths, selected by `config.multiTenantMode`:
//
//   LEGACY (`resolveLegacyKdsMerchantId`, the only path when mode === "off"):
//   - DEVICE token: store-bound. `?merchantId=` may select among allowed stores;
//     `ensureDeviceMerchantAccess` then rejects anything but the bound store.
//   - SESSION: ignores the client `?merchantId=` and pins to the configured
//     default merchant — the interim IDOR-safe pin (a pre-Phase-2 session carried
//     no merchant/tenant scope, so a requested store was an unauthenticated
//     assertion).
//
//   TENANT-SCOPED (`resolveTenantScopedMerchantId`, used to enforce/observe when
//   mode != "off"): the principal now carries a tenant (`auth.tenantId` — from
//   the session claim or the device token, ADR-0818 Phase 2). The requested store
//   is HONORED but VALIDATED to belong to that tenant; a cross-tenant / unknown
//   merchant resolves to null (fail closed → 400). This both closes the IDOR and
//   finally enables the within-tenant store switcher a session was denied before.
//
// `multiTenantMode`: "off" = legacy only (zero behavior change, no extra query).
// "observe" = compute the tenant-scoped value and log any divergence, but still
// RETURN legacy (a dual-read parity window — verify in Loki before enforcing).
// "enforce" = RETURN the tenant-scoped value (fail closed).
async function resolveLegacyKdsMerchantId(
  services: AppServices,
  auth: KdsAuthContext,
  requested: string | undefined
): Promise<string | null> {
  if (auth.type === "device") {
    return resolveDefaultCloverMerchantId(services.prisma, services.config, requested ?? auth.merchantId);
  }
  return resolveDefaultCloverMerchantId(services.prisma, services.config, undefined);
}

// Does `merchantId` belong to `tenantId`? A CloverMerchant row carries a
// (Phase-1-backfilled) tenantId; a NULL one is a pre-backfill row treated as the
// default tenant for the additive single-tenant window. Unknown merchant → false.
async function merchantBelongsToTenant(
  services: AppServices,
  merchantId: string,
  tenantId: string
): Promise<boolean> {
  const merchant = await services.prisma.cloverMerchant.findUnique({
    where: { id: merchantId },
    select: { tenantId: true }
  });
  if (!merchant) {
    return false;
  }
  return (merchant.tenantId ?? DEFAULT_TENANT_ID) === tenantId;
}

// Tenant-validated resolution. Returns null (fail closed) when the principal has
// no tenant claim, no candidate store, or the candidate is not in its tenant.
async function resolveTenantScopedMerchantId(
  services: AppServices,
  auth: KdsAuthContext,
  requested: string | undefined,
  legacyMerchantId: string | null
): Promise<string | null> {
  if (!auth.tenantId) {
    return null;
  }
  // Device honors requested → bound; session honors requested → the legacy
  // in-tenant default. Either way the candidate is then validated against the
  // principal's tenant.
  const candidate =
    auth.type === "device" ? requested ?? auth.merchantId ?? legacyMerchantId : requested ?? legacyMerchantId;
  if (!candidate) {
    return null;
  }
  return (await merchantBelongsToTenant(services, candidate, auth.tenantId)) ? candidate : null;
}

export async function resolveKdsMerchantId(
  services: AppServices,
  auth: KdsAuthContext,
  requested: string | undefined,
  log?: ParityLogger
): Promise<string | null> {
  const legacy = await resolveLegacyKdsMerchantId(services, auth, requested);
  const mode = services.config.multiTenantMode;
  if (mode === "off") {
    return legacy;
  }

  const scoped = await resolveTenantScopedMerchantId(services, auth, requested, legacy);
  if (scoped !== legacy && log) {
    log.warn(
      {
        scope: "kds.tenant.parity",
        mode,
        authType: auth.type,
        tenantId: auth.tenantId ?? null,
        requested: requested ?? null,
        legacyMerchantId: legacy,
        scopedMerchantId: scoped
      },
      "KDS tenant-scoped merchant resolution diverged from legacy"
    );
  }
  return mode === "enforce" ? scoped : legacy;
}

export type ResolvedKdsMerchant =
  // Authenticated + (for devices) store-access-checked. `merchantId` is the
  // store this request is authorized for, or null when none could be resolved
  // (e.g. no merchant configured yet) — the route handlers turn a null into a
  // 400. `rejected` is false: the caller continues.
  | { rejected: false; auth: KdsAuthContext; merchantId: string | null }
  // Auth or store-access failed; `reply` already carries the status (401/403).
  // The caller must stop and return.
  | { rejected: true };

// Single authoritative "what store is this /api/kds/* request authorized for?"
// decision, shared by the app preHandler (app.ts) and its tests so the security
// path under test is the *same code* that runs in production (no drift).
//
// Steps: authenticate (session cookie or device bearer) -> resolve the store
// (`resolveKdsMerchantId`: a session is pinned to its authorized merchant and
// can NOT pick via ?merchantId=; a device falls back to its bound store) ->
// enforce the device's store claim (`ensureDeviceMerchantAccess`). On any
// failure the reply code is set (401 unauthorized / 403 forbidden) and
// `{ rejected: true }` is returned; the caller should stop. On success the
// resolved merchant is the authorization boundary every downstream ownership
// guard checks against.
//
// Note: the CSRF write-origin check for session mutations is intentionally NOT
// here — it is a separate concern layered on top by the preHandler.
export async function resolveKdsRequestMerchant(
  services: AppServices,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<ResolvedKdsMerchant> {
  const auth = await authenticateKdsRequest(services, request);
  if (!auth.ok) {
    rejectUnauthorized(reply);
    return { rejected: true };
  }

  const requestedMerchantId = resolveRequestedMerchantId(request);
  const resolvedMerchantId = await resolveKdsMerchantId(services, auth.context, requestedMerchantId, request.log);
  if (!ensureDeviceMerchantAccess(auth.context, requestedMerchantId, resolvedMerchantId, reply)) {
    return { rejected: true };
  }

  return { rejected: false, auth: auth.context, merchantId: resolvedMerchantId };
}

export type ResolvedDisplayMerchant =
  | { rejected: false; merchantId: string | null }
  | { rejected: true; code: 401 | 403 };

// Resolve the store a customer "order-ready" display request/socket operates on,
// STAGED on MULTITENANT_MODE (ADR-0818 Phase 2b/2c). A display is a paired,
// login-less kiosk; this is the display-side analogue of resolveKdsRequestMerchant.
//
//   off (prod default): PUBLIC — resolve from `?merchantId=` exactly as before
//     (byte-for-byte). `/display` + `/ws/display` have always been an
//     unauthenticated trusted-LAN surface; off-mode keeps that contract.
//   observe: still PUBLIC (returns the legacy result), but when a paired device
//     token IS present, log when its bound store diverges from the `?merchantId=`
//     resolution — the display-surface parity signal before enforcing.
//   enforce: require a valid DEVICE token (rides the same-origin cookie on both
//     the HTTP call and the WS handshake); resolve to its bound store and reject a
//     mismatched `?merchantId=`. This closes the untrusted-param IDOR on /display.
export async function resolveDisplayMerchant(
  services: AppServices,
  request: FastifyRequest
): Promise<ResolvedDisplayMerchant> {
  const requested = resolveRequestedMerchantId(request);
  const mode = services.config.multiTenantMode;

  if (mode === "enforce") {
    const auth = await authenticateKdsRequest(services, request);
    if (!auth.ok || auth.context.type !== "device" || !auth.context.merchantId) {
      return { rejected: true, code: 401 };
    }
    // A paired display is bound to one store; honor only its own store.
    if (requested && requested !== auth.context.merchantId) {
      return { rejected: true, code: 403 };
    }
    return { rejected: false, merchantId: auth.context.merchantId };
  }

  const legacy = await resolveDefaultCloverMerchantId(services.prisma, services.config, requested);

  if (mode === "observe") {
    const auth = await authenticateKdsRequest(services, request);
    if (
      auth.ok &&
      auth.context.type === "device" &&
      auth.context.merchantId &&
      auth.context.merchantId !== legacy
    ) {
      request.log.warn(
        {
          scope: "kds.tenant.parity",
          surface: "display",
          requested: requested ?? null,
          legacyMerchantId: legacy,
          deviceMerchantId: auth.context.merchantId
        },
        "display merchant resolution diverged from the paired device's bound store"
      );
    }
  }

  return { rejected: false, merchantId: legacy };
}
