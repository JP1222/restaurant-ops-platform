import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppConfig } from "../config.js";
import type { DbPool } from "../db.js";
import { singleHeaderValue, tokenEquals } from "../lib/auth.js";
import { asArray, asRecord, asString } from "../lib/json.js";
import { createLogger } from "../lib/log.js";
import { JobRepository } from "../scheduler/job-repository.js";
import type { JsonRecord } from "../types.js";

const MAX_BODY_BYTES = 1024 * 1024;

const log = createLogger("clover");

export async function handleCloverWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  pool: DbPool,
  config: AppConfig
) {
  if (!isJsonRequest(req)) {
    return respondJson(res, 415, { error: "application/json is required" });
  }

  const rawBody = await readBody(req, MAX_BODY_BYTES).catch((error) => {
    if (error instanceof Error && error.message === "body_too_large") {
      return null;
    }
    throw error;
  });
  if (rawBody === null) {
    return respondJson(res, 413, { error: "request body is too large" });
  }

  let payload: JsonRecord;
  try {
    payload = JSON.parse(rawBody) as JsonRecord;
  } catch {
    return respondJson(res, 400, { error: "invalid JSON" });
  }

  if (Object.prototype.hasOwnProperty.call(payload, "verificationCode")) {
    return handleVerificationCode(res, pool, config, payload);
  }

  if (!tokenEquals(singleHeaderValue(req.headers["x-clover-auth"]), config.cloverWebhookAuthCode)) {
    return respondJson(res, 401, { error: "invalid Clover webhook auth" });
  }

  const updates = parseWebhookPayload(payload);
  await insertInboxBatch(pool, updates, config.cloverMerchantId);

  return respondJson(res, 200, { ok: true, received: updates.length });
}

async function handleVerificationCode(
  res: ServerResponse,
  pool: DbPool,
  config: AppConfig,
  payload: JsonRecord
) {
  const keys = Object.keys(payload);
  const verificationCode = asString(payload.verificationCode);
  if (keys.length !== 1 || !verificationCode || verificationCode.length > 255) {
    return respondJson(res, 400, { error: "invalid verification code payload" });
  }

  const existing = await pool.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM audit.webhook_verifications WHERE code = $1) AS exists",
    [verificationCode]
  );
  if (existing.rows[0]?.exists === true) {
    return respondJson(res, 200, { ok: true });
  }

  const count = await pool.query<{ count: number }>(
    `
      SELECT count(*)::integer AS count
      FROM audit.webhook_verifications
      WHERE received_at >= now() - interval '1 hour'
    `
  );
  if (Number(count.rows[0]?.count ?? 0) >= config.webhookVerificationMaxPerHour) {
    return respondJson(res, 429, { error: "too many verification codes" });
  }

  await pool.query(
    `
      INSERT INTO audit.webhook_verifications (code, raw_event)
      VALUES ($1, $2::jsonb)
      ON CONFLICT (code) DO NOTHING
    `,
    [verificationCode, JSON.stringify(payload)]
  );
  log.info("Received Clover webhook verification code");
  return respondJson(res, 200, { ok: true });
}

export async function enqueueForUpdate(
  jobs: JobRepository,
  config: AppConfig,
  update: ParsedUpdate
) {
  if (update.objectType === "O") {
    await jobs.enqueue({
      jobType: "webhook_fetch_order",
      merchantId: update.merchantId,
      dedupeKey: `${update.merchantId}:order:${update.objectId}`,
      payload: {
        orderId: update.objectId,
        eventTs: update.eventTs?.toISOString()
      },
      runAfter: new Date(Date.now() + config.webhookOrderDebounceSeconds * 1000),
      priority: 10
    });
  } else if (update.objectType === "P") {
    await jobs.enqueue({
      jobType: "webhook_fetch_payment",
      merchantId: update.merchantId,
      dedupeKey: `${update.merchantId}:payment:${update.objectId}`,
      payload: {
        paymentId: update.objectId,
        eventTs: update.eventTs?.toISOString()
      },
      runAfter: new Date(),
      priority: 10
    });
  } else if (update.objectType === "E") {
    await jobs.enqueue({
      jobType: "reference_data_refresh",
      merchantId: update.merchantId,
      dedupeKey: `${update.merchantId}:reference_data_refresh:employees`,
      payload: { resource: "employees" },
      runAfter: new Date(),
      priority: 25
    });
  }
}

export async function insertInbox(pool: DbPool, update: ParsedUpdate, acceptedMerchantId?: string) {
  await insertInboxBatch(pool, [update], acceptedMerchantId);
}

export async function insertInboxBatch(pool: DbPool, updates: ParsedUpdate[], acceptedMerchantId?: string) {
  if (updates.length === 0) {
    return 0;
  }

  let inserted = 0;
  for (let index = 0; index < updates.length; index += 500) {
    inserted += await insertInboxChunk(pool, updates.slice(index, index + 500), acceptedMerchantId);
  }
  return inserted;
}

async function insertInboxChunk(pool: DbPool, updates: ParsedUpdate[], acceptedMerchantId?: string) {
  const values: string[] = [];
  const params: unknown[] = [];
  for (const update of updates) {
    const offset = params.length;
    values.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}::jsonb, $${offset + 7}, $${offset + 8})`);
    params.push(
      update.merchantId,
      update.objectId,
      update.objectType,
      update.eventType,
      update.eventTs ?? null,
      JSON.stringify(update.raw),
      update.dedupeKey,
      acceptedMerchantId && update.merchantId !== acceptedMerchantId ? "ignored" : "pending"
    );
  }

  const result = await pool.query(
    `
      INSERT INTO audit.webhook_inbox (
        merchant_id, object_id, object_type, event_type, event_ts, raw_event, dedupe_key, status
      )
      VALUES ${values.join(", ")}
      ON CONFLICT (dedupe_key) DO NOTHING
    `,
    params
  );
  return result.rowCount ?? 0;
}

export function parseWebhookPayload(payload: JsonRecord): ParsedUpdate[] {
  const merchants = asRecord(payload.merchants);
  const updates: ParsedUpdate[] = [];
  for (const [merchantId, rawUpdates] of Object.entries(merchants)) {
    for (const rawUpdate of asArray(rawUpdates)) {
      const record = asRecord(rawUpdate);
      const objectRef = asString(record.objectId);
      if (!objectRef || !objectRef.includes(":")) {
        continue;
      }
      const [objectType, objectId] = objectRef.split(":");
      if (!objectType || !objectId) {
        continue;
      }
      const eventType = asString(record.type) ?? "UNKNOWN";
      const ts = typeof record.ts === "number" ? new Date(record.ts) : null;
      const eventTs = ts && !Number.isNaN(ts.getTime()) ? ts : undefined;
      updates.push({
        merchantId,
        objectType,
        objectId,
        eventType,
        eventTs,
        raw: record,
        dedupeKey: `${merchantId}:${objectRef}:${eventType}:${eventTs?.toISOString() ?? "unknown"}`
      });
    }
  }
  return updates;
}

export type ParsedUpdate = {
  merchantId: string;
  objectType: string;
  objectId: string;
  eventType: string;
  eventTs?: Date;
  raw: JsonRecord;
  dedupeKey: string;
};

function isJsonRequest(req: IncomingMessage) {
  const contentType = req.headers["content-type"];
  return typeof contentType === "string" && contentType.toLowerCase().includes("application/json");
}

async function readBody(req: IncomingMessage, maxBytes: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxBytes) {
      throw new Error("body_too_large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function respondJson(res: ServerResponse, statusCode: number, payload: unknown) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload));
}
