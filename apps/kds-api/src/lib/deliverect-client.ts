import type { IncomingHttpHeaders } from "node:http";
import {
  KdsTicketStatus,
  MerchantAuthStatus,
  OrderProvider,
  type KdsProviderConfig,
  type PrismaClient
} from "@rop/db-kds";
import type { AppConfig } from "../config.js";
import { resolveDeliverectApiToken, resolveDeliverectHmacSecret } from "./board-settings.js";
import { computeHmacSha256Hex, timingSafeCompare } from "./crypto.js";

type JsonRecord = Record<string, unknown>;
type ProviderConfigRecord = Pick<
  KdsProviderConfig,
  | "merchantId"
  | "enabled"
  | "environment"
  | "externalLocationId"
  | "providerLocationId"
  | "channelLinkId"
  | "apiToken"
  | "hmacSecret"
  | "apiTokenCipher"
  | "hmacSecretCipher"
>;
type TicketStatusRecord = {
  merchantId: string;
  sourceOrderId: string;
  status: KdsTicketStatus;
  lastActor: string | null;
};

const DELIVERECT_PROVIDER = OrderProvider.DELIVERECT;
const DELIVERECT_STAGING = "STAGING";
const DELIVERECT_PRODUCTION = "PRODUCTION";

const DEFAULT_DELIVERECT_SIGNATURE_HEADERS = [
  "x-server-authorization-hmac-sha256",
  "x-deliverect-hmac-sha256"
] as const;

function asString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readHeader(headers: IncomingHttpHeaders, name: string) {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function normalizeSignature(value: string) {
  return value.trim().replace(/^sha256=/i, "").toLowerCase();
}

function mapTicketStatusToDeliverectStatus(status: KdsTicketStatus) {
  switch (status) {
    case KdsTicketStatus.IN_PROGRESS:
      return 50;
    case KdsTicketStatus.READY:
      return 70;
    case KdsTicketStatus.COMPLETED:
      return 90;
    default:
      return 20;
  }
}

function defaultReasonForStatus(status: KdsTicketStatus) {
  switch (status) {
    case KdsTicketStatus.IN_PROGRESS:
      return "Order is being prepared.";
    case KdsTicketStatus.READY:
      return "Order is ready for pickup.";
    case KdsTicketStatus.COMPLETED:
      return "Order is finalized.";
    default:
      return "Order acknowledged in Example Kitchen KDS.";
  }
}

function providerLookupFromPayload(payload: JsonRecord) {
  return {
    externalLocationId: asString(payload.externalLocationId) ?? asString(payload.channelLocationId),
    providerLocationId: asString(payload.locationId) ?? asString(payload.location),
    channelLinkId: asString(payload.channelLinkId) ?? asString(payload.channelLink),
    locationName: asString(payload.locationName) ?? asString(payload.channelLinkName)
  };
}

export type DeliverectRegisterResponse = {
  productSyncUrl: string;
  orderWebhookUrl: string;
  orderStatusUpdateUrl: string;
};

export type DeliverectWebhookVerification = {
  valid: boolean;
  headerName: string | null;
  signature: string | null;
  expectedSignature: string | null;
  secretSource: "provider_config" | "app_config" | "missing";
  skipped: boolean;
};

export function buildDeliverectWebhookUrls(appBaseUrl: string): DeliverectRegisterResponse {
  const origin = appBaseUrl.replace(/\/$/, "");
  return {
    productSyncUrl: `${origin}/api/deliverect/products`,
    orderWebhookUrl: `${origin}/api/deliverect/orders`,
    orderStatusUpdateUrl: `${origin}/api/deliverect/order-status`
  };
}

export function buildDeliverectStatusPayload(ticket: TicketStatusRecord) {
  return {
    orderId: ticket.sourceOrderId,
    status: mapTicketStatusToDeliverectStatus(ticket.status),
    reason: ticket.lastActor ? `${defaultReasonForStatus(ticket.status)} Actor: ${ticket.lastActor}.` : defaultReasonForStatus(ticket.status)
  };
}

export class DeliverectClient {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly config: AppConfig
  ) {}

  buildWebhookUrls() {
    return buildDeliverectWebhookUrls(this.config.appBaseUrl);
  }

  async findProviderConfig(payload: JsonRecord): Promise<ProviderConfigRecord | null> {
    const lookup = providerLookupFromPayload(payload);
    const or = [
      lookup.channelLinkId ? { channelLinkId: lookup.channelLinkId } : null,
      lookup.providerLocationId ? { providerLocationId: lookup.providerLocationId } : null,
      lookup.externalLocationId ? { externalLocationId: lookup.externalLocationId } : null
    ].filter((value): value is NonNullable<typeof value> => value !== null);

    if (or.length === 0) {
      return null;
    }

    return this.prisma.kdsProviderConfig.findFirst({
      where: {
        provider: DELIVERECT_PROVIDER,
        OR: or
      }
    });
  }

  verifyWebhookSignature(
    headers: IncomingHttpHeaders,
    rawBody: string | undefined,
    payload: JsonRecord,
    providerConfig: ProviderConfigRecord | null
  ): DeliverectWebhookVerification {
    const configuredHeader = this.config.deliverectWebhookSignatureHeader.toLowerCase();
    const headerNames = Array.from(
      new Set([configuredHeader, ...DEFAULT_DELIVERECT_SIGNATURE_HEADERS])
    );

    let signature: string | null = null;
    let headerName: string | null = null;
    for (const candidate of headerNames) {
      const value = readHeader(headers, candidate);
      if (value) {
        signature = value;
        headerName = candidate;
        break;
      }
    }

    const resolvedHmacSecret = resolveDeliverectHmacSecret(providerConfig);
    const secret = resolvedHmacSecret ?? this.config.deliverectWebhookSecret;
    const secretSource =
      resolvedHmacSecret
        ? "provider_config"
          : this.config.deliverectWebhookSecret
          ? "app_config"
          : "missing";

    const isProductionConfig =
      this.config.nodeEnv === "production" ||
      providerConfig?.environment === DELIVERECT_PRODUCTION;
    if (isProductionConfig && !secret) {
      return {
        valid: false,
        headerName,
        signature,
        expectedSignature: null,
        secretSource: "missing",
        skipped: false
      };
    }

    if (!signature && !secret) {
      return {
        valid: true,
        headerName: null,
        signature: null,
        expectedSignature: null,
        secretSource,
        skipped: true
      };
    }

    if (!signature || !secret || !rawBody) {
      return {
        valid: false,
        headerName,
        signature,
        expectedSignature: null,
        secretSource,
        skipped: false
      };
    }

    const expectedSignature = computeHmacSha256Hex(secret, rawBody);
    return {
      valid: timingSafeCompare(expectedSignature, normalizeSignature(signature)),
      headerName,
      signature,
      expectedSignature,
      secretSource,
      skipped: false
    };
  }

  async registerLocation(payload: JsonRecord) {
    const lookup = providerLookupFromPayload(payload);
    const existingConfig = await this.findProviderConfig(payload);
    const merchantId = existingConfig?.merchantId ?? lookup.externalLocationId ?? lookup.providerLocationId;

    if (!merchantId) {
      return this.buildWebhookUrls();
    }

    await this.prisma.cloverMerchant.upsert({
      where: { id: merchantId },
      update: {
        authStatus: MerchantAuthStatus.ACTIVE,
        lastWebhookAt: new Date(),
        webhookStatus: "healthy",
        ...(lookup.locationName ? { name: lookup.locationName } : {})
      },
      create: {
        id: merchantId,
        name: lookup.locationName ?? merchantId,
        // Webhook-only Deliverect store row (ADR-0019): holds NO POS token. It is
        // discriminated by `region: "DELIVERECT"` + its KdsProviderConfig, not a
        // token sentinel — the plaintext accessToken column (which used to carry
        // the `deliverect:webhook` sentinel) was dropped in
        // 20260618_drop_pos_token_plaintext.
        authStatus: MerchantAuthStatus.ACTIVE,
        region: "DELIVERECT",
        webhookStatus: "healthy",
        lastWebhookAt: new Date()
      }
    });

    await this.prisma.kdsProviderConfig.upsert({
      where: {
        merchantId_provider: {
          merchantId,
          provider: DELIVERECT_PROVIDER
        }
      },
      update: {
        enabled: true,
        externalLocationId: lookup.externalLocationId,
        providerLocationId: lookup.providerLocationId,
        channelLinkId: lookup.channelLinkId,
        registerWebhookStatus: "healthy",
        lastRegisterWebhookAt: new Date()
      },
      create: {
        merchantId,
        provider: DELIVERECT_PROVIDER,
        enabled: true,
        environment: DELIVERECT_STAGING,
        externalLocationId: lookup.externalLocationId,
        providerLocationId: lookup.providerLocationId,
        channelLinkId: lookup.channelLinkId,
        registerWebhookStatus: "healthy",
        lastRegisterWebhookAt: new Date()
      }
    });

    return this.buildWebhookUrls();
  }

  async recordOrderWebhook(payload: JsonRecord) {
    const lookup = providerLookupFromPayload(payload);
    const existingConfig = await this.findProviderConfig(payload);
    const merchantId = existingConfig?.merchantId ?? lookup.externalLocationId ?? lookup.providerLocationId;

    if (!merchantId) {
      return null;
    }

    await this.prisma.cloverMerchant.upsert({
      where: { id: merchantId },
      update: {
        authStatus: MerchantAuthStatus.ACTIVE,
        lastWebhookAt: new Date(),
        webhookStatus: "healthy",
        ...(lookup.locationName ? { name: lookup.locationName } : {})
      },
      create: {
        id: merchantId,
        name: lookup.locationName ?? merchantId,
        // Webhook-only Deliverect store row (ADR-0019): holds NO POS token. It is
        // discriminated by `region: "DELIVERECT"` + its KdsProviderConfig, not a
        // token sentinel — the plaintext accessToken column (which used to carry
        // the `deliverect:webhook` sentinel) was dropped in
        // 20260618_drop_pos_token_plaintext.
        authStatus: MerchantAuthStatus.ACTIVE,
        region: "DELIVERECT",
        webhookStatus: "healthy",
        lastWebhookAt: new Date()
      }
    });

    await this.prisma.kdsProviderConfig.upsert({
      where: {
        merchantId_provider: {
          merchantId,
          provider: DELIVERECT_PROVIDER
        }
      },
      update: {
        enabled: true,
        externalLocationId: lookup.externalLocationId,
        providerLocationId: lookup.providerLocationId,
        channelLinkId: lookup.channelLinkId,
        ordersWebhookStatus: "healthy",
        lastOrderWebhookAt: new Date()
      },
      create: {
        merchantId,
        provider: DELIVERECT_PROVIDER,
        enabled: true,
        environment: DELIVERECT_STAGING,
        externalLocationId: lookup.externalLocationId,
        providerLocationId: lookup.providerLocationId,
        channelLinkId: lookup.channelLinkId,
        ordersWebhookStatus: "healthy",
        lastOrderWebhookAt: new Date()
      }
    });

    return { merchantId };
  }

  async pushTicketStatus(ticket: TicketStatusRecord) {
    const providerConfig = await this.prisma.kdsProviderConfig.findUnique({
      where: {
        merchantId_provider: {
          merchantId: ticket.merchantId,
          provider: DELIVERECT_PROVIDER
        }
      }
    });

    const resolvedApiToken = resolveDeliverectApiToken(providerConfig);
    if (!providerConfig?.enabled || !resolvedApiToken) {
      return null;
    }

    const payload = buildDeliverectStatusPayload(ticket);
    const apiBaseUrl =
      providerConfig.environment === DELIVERECT_PRODUCTION
        ? this.config.deliverectApiUrl
        : this.config.deliverectStagingApiUrl;
    const response = await fetch(
      `${apiBaseUrl}/kds/orderStatus/${encodeURIComponent(ticket.sourceOrderId)}`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${resolvedApiToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(payload),
        // Bound the call so a hung Deliverect API can't starve the BullMQ
        // fulfillment worker indefinitely (mirrors clover-client.ts, GH #122).
        signal: AbortSignal.timeout(10_000)
      }
    );

    if (!response.ok) {
      throw new Error(`Deliverect status update failed with ${response.status} for order ${ticket.sourceOrderId}.`);
    }

    return payload;
  }
}
