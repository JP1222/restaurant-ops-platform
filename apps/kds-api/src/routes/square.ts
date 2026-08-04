import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  type CatalogImportResult,
  SquareConnectRequestSchema,
  SquareImportCatalogRequestSchema,
} from "@rop/contracts";

import { createAdminBearerGuard } from "../lib/admin-bearer-auth.js";
import type { AppServices } from "../lib/services.js";
import { persistSquareConnection, SquarePersistError } from "../lib/square-account.js";
import { pushSquareSyncTargets } from "../lib/square-analytics-sync.js";
import { SquareConnectError } from "../lib/square-client.js";
import { importSquareCatalog, SquareStoreError } from "../lib/square-menu.js";

// Translate a connect/persist failure into an HTTP reply. Logs ONLY the coarse
// kind — never the token, and never a raw SquareError (whose `.body` is
// enumerable). A SquareError never reaches here: square-client converts it to a
// SquareConnectError first.
function replyForSquareError(
  request: FastifyRequest,
  reply: FastifyReply,
  err: unknown
): { error: string; message?: string } {
  if (err instanceof SquareConnectError) {
    request.log.warn({ scope: "square.connect", kind: err.kind }, "square connect failed");
    switch (err.kind) {
      case "invalid_token":
        reply.code(400);
        return {
          error: "invalid_token",
          message: "Invalid Square token, or the token is for the wrong environment (sandbox vs production)."
        };
      case "insufficient_scope":
        reply.code(400);
        return {
          error: "insufficient_scope",
          message: "The Square token lacks the required read permission (MERCHANT_PROFILE_READ)."
        };
      case "no_locations":
        reply.code(422);
        return { error: "no_locations", message: "This Square account has no active locations." };
      case "timeout":
        reply.code(504);
        return { error: "square_timeout", message: "Square did not respond in time. Please try again." };
      default:
        reply.code(502);
        return { error: "square_upstream", message: "Square returned an unexpected error." };
    }
  }
  if (err instanceof SquarePersistError) {
    request.log.warn({ scope: "square.connect", kind: err.kind }, "square persist failed");
    reply.code(422);
    return { error: "location_id_too_long", message: "A Square location id is too long to store." };
  }
  if (err instanceof SquareStoreError) {
    request.log.warn({ scope: "square.import", kind: err.kind }, "square store lookup failed");
    if (err.kind === "not_found") {
      reply.code(404);
      return { error: "not_found", message: "That store could not be found." };
    }
    reply.code(409);
    return { error: "not_square", message: "That store is not connected to Square." };
  }
  // Truly unexpected (e.g. a DB error) — let Fastify's error handler 500 it.
  throw err;
}

// Square store onboarding (store #2; docs/square-onboarding.md). ADMIN-bearer
// only — called by the backoffice BFF, never public like /api/order/*. PAT/paste
// path; an OAuth install/callback would reuse the same validate + persist code.
export async function registerSquareRoutes(app: FastifyInstance, services: AppServices) {
  const { config, prisma, square } = services;
  const adminBearer = createAdminBearerGuard(config.kdsInternalAdminToken);

  // Validate-only probe for the wizard's "Test connection" + location-select.
  // Persists NOTHING.
  app.post(
    "/api/square/test-connection",
    { preHandler: adminBearer },
    async (request, reply) => {
      const parsed = SquareConnectRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid_body" };
      }
      try {
        const info = await square.validateAndListLocations(parsed.data.accessToken, parsed.data.environment);
        return {
          merchantId: info.merchantId,
          merchantName: info.merchantName,
          environment: parsed.data.environment,
          locations: info.locations
        };
      } catch (err) {
        return replyForSquareError(request, reply, err);
      }
    }
  );

  // Validate + persist: ONE PosAccount + one PosStore per active location, in a
  // single transaction. Re-validates the token (never trusts a prior probe).
  app.post(
    "/api/square/connect",
    { preHandler: adminBearer },
    async (request, reply) => {
      const parsed = SquareConnectRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid_body" };
      }
      const { accessToken, environment } = parsed.data;
      try {
        // Fail-closed: re-validate before any write — never trust a prior
        // test-connection call.
        const info = await square.validateAndListLocations(accessToken, environment);
        const result = await persistSquareConnection(prisma, info, accessToken, environment);
        // Register the store(s) with analytics so its sales land in the mart
        // (Phase 4). Best-effort + never throws — a push failure must not fail the
        // connect (the store is live for KDS regardless).
        await pushSquareSyncTargets(config, result.stores, accessToken, request.log);
        reply.code(201);
        return {
          posAccountId: result.posAccountId,
          merchantId: info.merchantId,
          merchantName: info.merchantName,
          environment,
          // Masked echo only — the token itself is never returned (write-only).
          tokenLast4: accessToken.slice(-4),
          stores: result.stores
        };
      } catch (err) {
        return replyForSquareError(request, reply, err);
      }
    }
  );

  // Catalog / menu import (wizard step 4). Reads the bound store's LIVE Square
  // catalog and returns counts (ADR-0027: menu = POS inventory — nothing is
  // persisted; the menu is served live by /api/order/menu). The token is
  // resolved server-side from the PosStore's PosAccount, never re-sent.
  app.post(
    "/api/square/import-catalog",
    { preHandler: adminBearer },
    async (request, reply) => {
      const parsed = SquareImportCatalogRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid_body" };
      }
      const startedAt = Date.now();
      try {
        const counts = await importSquareCatalog(prisma, square, parsed.data.posStoreId);
        const result: CatalogImportResult = { ...counts, durationMs: Date.now() - startedAt };
        return result;
      } catch (err) {
        return replyForSquareError(request, reply, err);
      }
    }
  );
}
