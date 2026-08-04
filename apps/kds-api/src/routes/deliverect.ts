import { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { OrderProvider, type Prisma } from "@rop/db-kds";
import { normalizeDeliverectOrder } from "../domain/normalize-deliverect-order.js";
import { createProviderEvents, deliverectFingerprint, enqueueProviderEvents } from "../lib/provider-ingress.js";
import type { AppServices } from "../lib/services.js";
import { kdsProviderEnqueueFailuresTotal, kdsWebhookAckSeconds } from "../lib/metrics.js";

type JsonRecord = Record<string, unknown>;
type RequestLike = {
  headers: FastifyRequest["headers"];
  method: string;
  raw: {
    url?: string | undefined;
  };
};
type RawBodyRequest = RequestLike & { rawBody?: string };

function asRecord(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null ? (value as JsonRecord) : {};
}

function shouldCaptureRawBody(request: RequestLike) {
  const path = request.raw.url ?? "";
  return request.method !== "GET" && path.startsWith("/api/deliverect/");
}

async function verifyWebhook(
  services: AppServices,
  request: RawBodyRequest,
  payload: JsonRecord
) {
  const providerConfig = await services.deliverect.findProviderConfig(payload);
  return services.deliverect.verifyWebhookSignature(
    request.headers,
    request.rawBody,
    payload,
    providerConfig
  );
}

export async function registerDeliverectRoutes(app: FastifyInstance, services: AppServices) {
  app.addHook("preParsing", async (request, _reply, payload) => {
    if (!shouldCaptureRawBody(request)) {
      return payload;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of payload) {
      const rawChunk: unknown = chunk;
      if (Buffer.isBuffer(rawChunk)) {
        chunks.push(rawChunk);
      } else if (typeof rawChunk === "string" || rawChunk instanceof Uint8Array) {
        chunks.push(Buffer.from(rawChunk));
      } else {
        chunks.push(Buffer.from(String(rawChunk)));
      }
    }

    const rawBody = Buffer.concat(chunks);
    (request as RawBodyRequest).rawBody = rawBody.toString("utf8");
    return Readable.from(rawBody);
  });

  app.post("/api/deliverect/register", async (request, reply) => {
    const payload = asRecord(request.body);
    const verification = await verifyWebhook(services, request, payload);
    if (!verification.valid) {
      reply.code(401);
      return { error: "Invalid Deliverect webhook signature." };
    }

    return services.deliverect.registerLocation(payload);
  });

  app.post("/api/deliverect/orders", async (request, reply) => {
    const startedAt = Date.now();
    const payload = asRecord(request.body);
    const verification = await verifyWebhook(services, request, payload);
    if (!verification.valid) {
      reply.code(401);
      return { error: "Invalid Deliverect webhook signature." };
    }

    const resolved = await services.deliverect.recordOrderWebhook(payload);
    if (!resolved) {
      reply.code(400);
      return { error: "Unable to resolve merchant for Deliverect order webhook." };
    }

    const normalized = normalizeDeliverectOrder(payload, resolved.merchantId);
    const providerEvents = await createProviderEvents(services, [{
      provider: OrderProvider.DELIVERECT,
      merchantId: resolved.merchantId,
      sourceOrderId: normalized.sourceOrderId,
      fingerprint: deliverectFingerprint(resolved.merchantId, normalized.sourceOrderId, payload),
      topic: "order",
      raw: payload as Prisma.InputJsonValue,
      receivedAt: new Date(startedAt)
    }]);
    let enqueued: number;
    try {
      enqueued = await enqueueProviderEvents(services, providerEvents);
    } catch (cause) {
      kdsProviderEnqueueFailuresTotal.inc({ provider: "deliverect" });
      request.log.error({ err: cause }, "Failed to enqueue Deliverect provider events.");
      // Fail the ack so Deliverect redelivers rather than dropping the event on a
      // 200 (GH #460).
      reply.code(503);
      return { ok: false, error: "enqueue_failed" };
    }
    kdsWebhookAckSeconds.observe({ provider: "deliverect" }, (Date.now() - startedAt) / 1000);
    return {
      ok: true,
      enqueued
    };
  });

  app.get("/api/deliverect/products", async () => ({
    ok: true,
    acknowledged: true
  }));

  app.post("/api/deliverect/products", async (request, reply) => {
    const payload = asRecord(request.body);
    const verification = await verifyWebhook(services, request, payload);
    if (!verification.valid) {
      reply.code(401);
      return { error: "Invalid Deliverect webhook signature." };
    }

    return {
      ok: true,
      acknowledged: true
    };
  });

  app.post("/api/deliverect/order-status", async (request, reply) => {
    const payload = asRecord(request.body);
    const verification = await verifyWebhook(services, request, payload);
    if (!verification.valid) {
      reply.code(401);
      return { error: "Invalid Deliverect webhook signature." };
    }

    return {
      ok: true,
      acknowledged: true
    };
  });
}
