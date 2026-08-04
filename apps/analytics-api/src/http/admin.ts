import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppConfig } from "../config.js";
import type { DbPool } from "../db.js";
import { bearerToken, tokenEquals } from "../lib/auth.js";
import { readJsonBody, respondJson } from "./health.js";
import type { SyncTargetsRepository } from "../sync-targets/repository.js";

export function isAdminAuthorized(req: IncomingMessage, config: AppConfig) {
  return tokenEquals(bearerToken(req.headers.authorization), config.adminToken);
}

// Sync-target registration accepts EITHER the full admin token OR the dedicated,
// narrowly-scoped kds-api push token (so kds-api can register a Square store
// without holding admin reach over every other /admin route). One-way by
// construction: analytics never calls back to kds-api.
export function isSyncTargetWriteAuthorized(req: IncomingMessage, config: AppConfig) {
  const token = bearerToken(req.headers.authorization);
  if (tokenEquals(token, config.adminToken)) {
    return true;
  }
  return config.kdsAnalyticsPushToken ? tokenEquals(token, config.kdsAnalyticsPushToken) : false;
}

export async function handleAdminWebhookVerifications(
  req: IncomingMessage,
  res: ServerResponse,
  pool: DbPool,
  config: AppConfig
) {
  if (!isAdminAuthorized(req, config)) {
    return respondJson(res, 401, { error: "unauthorized" });
  }

  const result = await pool.query(
    `
      SELECT id, code, received_at, used_at
      FROM audit.webhook_verifications
      ORDER BY received_at DESC
      LIMIT 10
    `
  );
  return respondJson(res, 200, { verifications: result.rows });
}

const SYNC_TARGET_MAX_BODY_BYTES = 8 * 1024;

// Register/update a store analytics should sync (multi-location, ADR-0018).
// Backoffice POSTs here (bearer ADMIN_TOKEN) when a store's POS is connected.
// Never logs the token (AGENTS.md: no provider secrets in logs).
export async function handleAdminSyncTargets(
  req: IncomingMessage,
  res: ServerResponse,
  config: AppConfig,
  syncTargets: SyncTargetsRepository
) {
  if (!isSyncTargetWriteAuthorized(req, config)) {
    return respondJson(res, 401, { error: "unauthorized" });
  }

  const contentType = req.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return respondJson(res, 415, { error: "unsupported_media_type" });
  }

  let bodyText: string;
  try {
    bodyText = await readJsonBody(req, SYNC_TARGET_MAX_BODY_BYTES);
  } catch {
    return respondJson(res, 413, { error: "body_too_large" });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return respondJson(res, 400, { error: "invalid_json" });
  }
  if (!parsed || typeof parsed !== "object") {
    return respondJson(res, 400, { error: "invalid_body" });
  }

  const {
    merchant_id: merchantId,
    token,
    provider,
    store_timezone: storeTimezone,
    active
  } = parsed as {
    merchant_id?: unknown;
    token?: unknown;
    provider?: unknown;
    store_timezone?: unknown;
    active?: unknown;
  };

  if (typeof merchantId !== "string" || merchantId.length === 0 || merchantId.length > 64) {
    return respondJson(res, 400, { error: "invalid_merchant_id" });
  }
  if (typeof token !== "string" || token.length === 0) {
    return respondJson(res, 400, { error: "invalid_token" });
  }
  if (provider !== undefined && typeof provider !== "string") {
    return respondJson(res, 400, { error: "invalid_provider" });
  }
  if (storeTimezone !== undefined && typeof storeTimezone !== "string") {
    return respondJson(res, 400, { error: "invalid_store_timezone" });
  }
  if (active !== undefined && typeof active !== "boolean") {
    return respondJson(res, 400, { error: "invalid_active" });
  }

  await syncTargets.upsert({
    merchantId,
    token,
    provider: typeof provider === "string" ? provider : undefined,
    storeTimezone: typeof storeTimezone === "string" ? storeTimezone : undefined,
    active: typeof active === "boolean" ? active : undefined
  });

  return respondJson(res, 200, { ok: true });
}
