import { describe, expect, it } from "vitest";
import { KdsTicketStatus } from "@rop/db-kds";
import type { AppConfig } from "../src/config.js";
import {
  buildDeliverectStatusPayload,
  buildDeliverectWebhookUrls,
  DeliverectClient
} from "../src/lib/deliverect-client.js";

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    nodeEnv: "test",
    apiPort: 4000,
    appBaseUrl: "https://kds.example.com",
    sessionSecret: "test-secret",
    databaseUrl: "postgres://example",
    redisUrl: "redis://example",
    webLoginUsername: "admin",
    webLoginPasswordHash: "hash",
    webLoginDisplayName: "Kitchen Admin",
    webauthnRpId: "kds.example.com",
    webauthnRpName: "Example Kitchen KDS",
    webSessionTtlHours: 12,
    cloverBaseUrl: "https://api.clover.com",
    cloverRegion: "US",
    cloverMerchantId: undefined,
    cloverToken: undefined,
    cloverAppId: undefined,
    cloverAppSecret: undefined,
    cloverWebhookAuthCode: undefined,
    deliverectWebhookSecret: undefined,
    deliverectWebhookSignatureHeader: "x-server-authorization-hmac-sha256",
    deliverectApiUrl: "https://api.deliverect.com",
    deliverectStagingApiUrl: "https://staging.deliverect.com",
    reconcileIntervalMs: 45_000,
    workerIntervalMs: 1_000,
    dailyResetEnabled: false,
    dailyResetHour: 21,
    dailyResetMinute: 0,
    dailyResetTimezone: "UTC",
    dailyResetCheckIntervalMs: 30_000,
    ...overrides
  };
}

describe("deliverect-client", () => {
  it("builds standardized webhook urls", () => {
    expect(buildDeliverectWebhookUrls("https://kds.example.com/")).toEqual({
      productSyncUrl: "https://kds.example.com/api/deliverect/products",
      orderWebhookUrl: "https://kds.example.com/api/deliverect/orders",
      orderStatusUpdateUrl: "https://kds.example.com/api/deliverect/order-status"
    });
  });

  it("maps KDS ticket status into Deliverect status payloads", () => {
    expect(buildDeliverectStatusPayload({
      merchantId: "merchant-1",
      sourceOrderId: "order-1",
      status: KdsTicketStatus.READY,
      lastActor: "Expo"
    })).toEqual({
      orderId: "order-1",
      status: 70,
      reason: "Order is ready for pickup. Actor: Expo."
    });
  });

  it("skips signature validation in test when no webhook secret is configured", () => {
    const rawBody = JSON.stringify({
      locationId: "loc-1",
      channelLinkId: "link-1"
    });
    const payload = JSON.parse(rawBody) as Record<string, unknown>;
    const client = new DeliverectClient({} as never, makeConfig());

    const verification = client.verifyWebhookSignature({}, rawBody, payload, null);
    expect(verification.valid).toBe(true);
    expect(verification.secretSource).toBe("missing");
    expect(verification.skipped).toBe(true);
  });
});
