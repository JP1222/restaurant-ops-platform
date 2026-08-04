import { CloverWebhookEventSchema, type CloverWebhookEvent } from "@rop/contracts";
import { z } from "zod";

const BatchUpdateSchema = z.object({
  objectId: z.string().min(1),
  type: z.string().nullable().optional(),
  ts: z.union([z.number(), z.string()]).nullable().optional(),
  orderId: z.string().nullable().optional(),
  eventId: z.string().nullable().optional(),
  id: z.string().nullable().optional()
}).passthrough();

const BatchPayloadSchema = z.object({
  appId: z.string().optional(),
  merchants: z.record(z.string(), z.array(BatchUpdateSchema))
}).passthrough();

const FlatPayloadSchema = z.object({
  merchantId: z.string().optional(),
  merchant_id: z.string().optional(),
  eventId: z.string().optional(),
  id: z.string().optional(),
  type: z.string().optional(),
  topic: z.string().optional(),
  orderId: z.string().optional(),
  objectId: z.string().optional(),
  merchant_object_id: z.string().optional(),
  modifiedTime: z.union([z.number(), z.string()]).optional(),
  modified_time: z.union([z.number(), z.string()]).optional(),
  timestamp: z.union([z.number(), z.string()]).optional()
}).passthrough();

function normalizeTimestamp(value: unknown) {
  if (typeof value !== "number" && typeof value !== "string") {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  const epochMilliseconds = Math.abs(parsed) < 100_000_000_000 ? parsed * 1000 : parsed;
  const date = new Date(epochMilliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function splitObjectId(objectId: string | null | undefined) {
  if (!objectId) {
    return { kind: null, value: null };
  }

  const separatorIndex = objectId.indexOf(":");
  if (separatorIndex === -1) {
    return { kind: null, value: objectId };
  }

  const kind = objectId.slice(0, separatorIndex) || null;
  const value = objectId.slice(separatorIndex + 1) || null;
  return { kind, value };
}

function extractOrderId(
  explicitOrderId: string | null | undefined,
  objectId: string | null | undefined
) {
  if (explicitOrderId) {
    return explicitOrderId;
  }

  const parsed = splitObjectId(objectId);
  if (parsed.kind === "O") {
    return parsed.value;
  }

  if (parsed.kind === null) {
    return parsed.value;
  }

  return null;
}

function normalizeEvent(
  merchantId: string | null | undefined,
  topic: string | null | undefined,
  orderId: string | null | undefined,
  timestamp: unknown,
  eventId: string | null | undefined,
  payload: Record<string, unknown>
) {
  if (!merchantId || !orderId) {
    return null;
  }

  const modifiedTime = normalizeTimestamp(timestamp);
  const stableEventId = eventId ?? `${merchantId}:${topic ?? "unknown"}:${orderId}:${modifiedTime ?? "unknown"}`;

  return CloverWebhookEventSchema.parse({
    merchantId,
    eventId: stableEventId,
    topic: topic ?? null,
    orderId,
    modifiedTime,
    payload
  });
}

export function parseCloverWebhookEvents(payload: Record<string, unknown>): CloverWebhookEvent[] {
  const batchResult = BatchPayloadSchema.safeParse(payload);
  if (batchResult.success) {
    const events: CloverWebhookEvent[] = [];

    for (const [merchantId, updates] of Object.entries(batchResult.data.merchants)) {
      for (const update of updates) {
        const orderId = extractOrderId(update.orderId ?? null, update.objectId);
        if (!orderId) {
          continue;
        }

        const event = normalizeEvent(
          merchantId,
          update.type ?? null,
          orderId,
          update.ts,
          update.eventId ?? update.id ?? null,
          {
            appId: batchResult.data.appId ?? null,
            merchantId,
            objectId: update.objectId,
            type: update.type ?? null,
            ts: update.ts ?? null,
            update
          }
        );

        if (event) {
          events.push(event);
        }
      }
    }

    return events;
  }

  const flat = FlatPayloadSchema.parse(payload);
  const merchantId = flat.merchantId ?? flat.merchant_id ?? null;
  const objectId = flat.objectId ?? flat.merchant_object_id ?? null;
  const orderId = extractOrderId(flat.orderId ?? null, objectId);
  const topic = flat.type ?? flat.topic ?? null;
  const timestamp = flat.modifiedTime ?? flat.modified_time ?? flat.timestamp;

  const event = normalizeEvent(
    merchantId,
    topic,
    orderId,
    timestamp,
    flat.eventId ?? flat.id ?? null,
    payload
  );

  return event ? [event] : [];
}

export function buildCloverWebhookFingerprint(event: CloverWebhookEvent) {
  return [
    event.merchantId,
    event.topic ?? "unknown",
    event.orderId ?? "unknown",
    event.modifiedTime ?? "unknown"
  ].join(":");
}
