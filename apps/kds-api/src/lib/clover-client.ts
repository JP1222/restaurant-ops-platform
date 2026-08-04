import type { KdsAction } from "@rop/contracts";
import { MerchantAuthStatus } from "@rop/db-kds";
import type { CloverMerchant, PrismaClient } from "@rop/db-kds";
import { getCloverApiOrigin, getCloverWebOrigin, type AppConfig } from "../config.js";
import type { CloverRateBucket, CloverRateLimiter } from "./clover-rate-limiter.js";
import {
  canBootstrapCloverMerchantFromEnv,
  getConfiguredCloverMerchantId,
  getConfiguredCloverToken
} from "./clover-runtime.js";
import { encryptSecretForStorage, resolveCloverMerchantSecrets } from "./pos-token.js";
import { kdsCloverFetchTimeoutsTotal, kdsCloverReconOrdersFetchedTotal, kdsCloverTokenRefreshDurationSeconds } from "./metrics.js";

type JsonRecord = Record<string, unknown>;
type CloverFulfillmentTicketRecord = {
  merchantId: string;
  // `cloverOrderId` is the internal namespaced id (`clover:<merchant>:<sourceOrderId>`,
  // built by buildInternalOrderId), NOT a Clover order id. Clover's orders API expects
  // the bare id — always use `sourceOrderId` for Clover calls (GH: push-fulfillment 401s).
  cloverOrderId: string;
  sourceOrderId: string;
};

export type CloverFulfillmentEventPayload = {
  orderFulfillmentEvent: {
    orderId: string;
    clientCreatedTime: number;
    type: string;
  };
};

type CloverTokenSet = {
  accessToken: string;
  refreshToken: string | null;
  accessTokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
};

const ACCESS_TOKEN_REFRESH_WINDOW_MS = 2 * 60 * 1000;

// Per-attempt timeout for every Clover API fetch(). Network hangs without a
// timeout block the worker indefinitely and starve BullMQ — see GH #122.
const CLOVER_FETCH_TIMEOUT_MS = 10_000;

// Reconciliation pagination (GH #166). Clover caps a single orders page at 100,
// so that is the page size. The max is a defensive ceiling: at the 5-minute
// reconciliation cadence even a very busy store stays far under 10k modified
// orders, and the bound stops a runaway loop if Clover ever returns full pages
// indefinitely.
const CLOVER_RECON_PAGE_SIZE = 100;
const CLOVER_RECON_MAX_ORDERS = 10_000;

/**
 * Stage label for timeout metrics + error messages. One label per Clover API
 * surface so on-call can tell a hung token refresh from a hung order POST.
 */
export type CloverFetchStage =
  | "token_exchange"
  | "refresh"
  | "recovery"
  | "request"
  | "request_retry"
  | "ecommerce_charge"
  | "ecommerce_refund";

/**
 * Thrown when a Clover fetch() exceeds {@link CLOVER_FETCH_TIMEOUT_MS}. The
 * `stage` field lets callers (and tests) distinguish a timeout from a generic
 * network error or a 429/5xx response.
 */
export class CloverTimeoutError extends Error {
  readonly stage: CloverFetchStage;
  readonly timeoutMs: number;

  constructor(stage: CloverFetchStage, timeoutMs: number) {
    super(`Clover ${stage} request timed out after ${timeoutMs}ms.`);
    this.name = "CloverTimeoutError";
    this.stage = stage;
    this.timeoutMs = timeoutMs;
  }
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const name = (error as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}

/**
 * Wrap `fetch()` with a fresh per-attempt AbortSignal.timeout(). Retries call
 * this anew so timeouts never stack — each attempt gets its own clock. Any
 * AbortError is rethrown as a typed {@link CloverTimeoutError} so callers can
 * tell hangs apart from 5xx and so the timeout counter increments cleanly.
 */
export async function cloverFetch(
  url: string,
  init: RequestInit | undefined,
  stage: CloverFetchStage
): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(CLOVER_FETCH_TIMEOUT_MS)
    });
  } catch (error) {
    if (isAbortError(error)) {
      kdsCloverFetchTimeoutsTotal.labels(stage).inc();
      throw new CloverTimeoutError(stage, CLOVER_FETCH_TIMEOUT_MS);
    }
    throw error;
  }
}

export function cloverFulfillmentEventTypeForAction(action: KdsAction) {
  switch (action) {
    case "hold":
      return "KDS_ON_HOLD";
    case "fire":
      return "KDS_RELEASED";
    case "start":
      return "KDS_IN_PROGRESS";
    case "ready":
      return "KDS_READY";
    case "complete":
    case "bump":
      return "KDS_COMPLETED";
    case "recall":
      return "KDS_RECALLED";
    default:
      return null;
  }
}

export function buildCloverFulfillmentEventPayload(
  ticket: CloverFulfillmentTicketRecord,
  action: KdsAction,
  occurredAt = new Date()
): CloverFulfillmentEventPayload | null {
  const type = cloverFulfillmentEventTypeForAction(action);
  if (!type) {
    return null;
  }

  return {
    orderFulfillmentEvent: {
      orderId: ticket.sourceOrderId,
      clientCreatedTime: occurredAt.getTime(),
      type
    }
  };
}

function tokenExpiryFromEpoch(expiresAt: unknown) {
  if (typeof expiresAt !== "number" && typeof expiresAt !== "string") {
    return null;
  }

  const parsed = Number(expiresAt);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  const epochMilliseconds = Math.abs(parsed) < 100_000_000_000 ? parsed * 1000 : parsed;
  const date = new Date(epochMilliseconds);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toHeaderObject(headers?: HeadersInit) {
  if (!headers) {
    return {};
  }

  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }

  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }

  return { ...headers };
}

function readResponseHeader(response: Response, headerName: string) {
  if (typeof response.headers.get === "function") {
    return response.headers.get(headerName);
  }

  const record = response.headers as unknown as Record<string, string | undefined>;
  return record[headerName];
}

function parseTokenSet(
  payload: JsonRecord,
  fallback: { accessToken?: string; refreshToken?: string | null } = {}
): CloverTokenSet {
  return {
    accessToken: typeof payload.access_token === "string"
      ? payload.access_token
      : fallback.accessToken ?? "",
    refreshToken: typeof payload.refresh_token === "string"
      ? payload.refresh_token
      : fallback.refreshToken ?? null,
    accessTokenExpiresAt: tokenExpiryFromEpoch(payload.access_token_expiration ?? payload.expires_at),
    refreshTokenExpiresAt: tokenExpiryFromEpoch(
      payload.refresh_token_expiration ?? payload.refresh_expires_at
    )
  };
}

function isExpiringSoon(expiresAt: Date | null | undefined) {
  if (!expiresAt) {
    return false;
  }

  return expiresAt.getTime() - Date.now() <= ACCESS_TOKEN_REFRESH_WINDOW_MS;
}

// Minimal structured logger surface (GH #134). The server passes Fastify's
// logger; tests and ad-hoc callers fall back to {@link defaultCloverLogger}.
export type CloverLogger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
};

const defaultCloverLogger: CloverLogger = {
  info: (obj, msg) => console.info(JSON.stringify({ level: "info", msg, ...(obj as object) })),
  warn: (obj, msg) => console.warn(JSON.stringify({ level: "warn", msg, ...(obj as object) }))
};

// Outcome label for the refresh-duration metric + structured log (GH #134).
type CloverRefreshOutcome = "success" | "recovery" | "timeout" | "error" | "noop";

export class CloverClient {
  private readonly logger: CloverLogger;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly config: AppConfig,
    private readonly rateLimiter?: CloverRateLimiter,
    logger?: CloverLogger
  ) {
    this.logger = logger ?? defaultCloverLogger;
  }

  buildAuthorizeUrl(state: string, merchantId?: string | null) {
    if (!this.config.cloverAppId) {
      throw new Error("CLOVER_APP_ID is required for OAuth install.");
    }

    const redirectUri = `${this.config.appBaseUrl}/api/clover/oauth/callback`;
    const params = new URLSearchParams({
      client_id: this.config.cloverAppId,
      response_type: "code",
      redirect_uri: redirectUri,
      state
    });

    if (merchantId) {
      params.set("merchant_id", merchantId);
    }

    return `${getCloverWebOrigin(this.config.cloverRegion)}/oauth/v2/authorize?${params.toString()}`;
  }

  async exchangeAuthorizationCode(code: string, merchantId: string) {
    if (!this.config.cloverAppId || !this.config.cloverAppSecret) {
      throw new Error("CLOVER_APP_ID and CLOVER_APP_SECRET are required.");
    }

    const redirectUri = `${this.config.appBaseUrl}/api/clover/oauth/callback`;
    const response = await cloverFetch(
      `${getCloverApiOrigin(this.config.cloverBaseUrl)}/oauth/v2/token`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json"
        },
        body: JSON.stringify({
          client_id: this.config.cloverAppId,
          client_secret: this.config.cloverAppSecret,
          code,
          redirect_uri: redirectUri
        })
      },
      "token_exchange"
    );

    if (!response.ok) {
      throw new Error(`Clover token exchange failed with ${response.status}.`);
    }

    const payload = (await response.json()) as JsonRecord;
    const tokens = parseTokenSet(payload);
    // Encrypt straight into the *Cipher columns (the plaintext columns were
    // dropped in 20260618_drop_pos_token_plaintext).
    const tokenColumns = {
      accessTokenCipher: encryptSecretForStorage(tokens.accessToken),
      refreshTokenCipher: encryptSecretForStorage(tokens.refreshToken),
      tokenExpiresAt: tokens.accessTokenExpiresAt,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
      recoveryTokenCipher: null,
      authStatus: MerchantAuthStatus.ACTIVE,
      appInstalledAt: new Date(),
      region: this.config.cloverRegion
    };
    await this.prisma.cloverMerchant.upsert({
      where: { id: merchantId },
      update: tokenColumns,
      create: { id: merchantId, ...tokenColumns }
    });
  }

  async bootstrapMerchantFromEnv() {
    if (!canBootstrapCloverMerchantFromEnv(this.config)) {
      return;
    }

    if (!this.config.cloverMerchantId || !this.config.cloverToken) {
      return;
    }

    const bootstrapColumns = {
      accessTokenCipher: encryptSecretForStorage(this.config.cloverToken),
      refreshTokenCipher: null,
      refreshTokenExpiresAt: null,
      recoveryTokenCipher: null,
      tokenExpiresAt: null,
      authStatus: MerchantAuthStatus.ACTIVE,
      region: this.config.cloverRegion
    };
    await this.prisma.cloverMerchant.upsert({
      where: { id: this.config.cloverMerchantId },
      update: bootstrapColumns,
      create: { id: this.config.cloverMerchantId, ...bootstrapColumns }
    });
  }

  // Lightweight token-validity probe (GH #170): GET the merchant profile. A 200
  // proves the configured token authenticates; a 401 throws (via requestJson's
  // status check) so boot-time validation can flag a stale/revoked token.
  async fetchMerchant(merchantId: string, options: { bucket?: CloverRateBucket } = {}) {
    return this.requestJson(
      merchantId,
      `/v3/merchants/${merchantId}`,
      undefined,
      options
    );
  }

  async fetchOrder(merchantId: string, orderId: string, options: { bucket?: CloverRateBucket } = {}) {
    return this.requestJson(
      merchantId,
      // customers.phoneNumbers is required for the loyalty accrual key — plain
      // `expand=customers` returns phoneNumbers: [] (verified, recipe doc §6).
      // `payments` is required for an ACCURATE paymentState: Clover computes
      // paymentState lazily, so the bare field can lag at OPEN indefinitely after
      // an online order settles (External Payment tender) — only expand=payments
      // forces it to recompute to PAID. Without this the unpaid-skip gate drops a
      // genuinely-paid online order and it never reaches the KDS (live-e2e finding).
      `/v3/merchants/${merchantId}/orders/${orderId}?expand=lineItems.modifications,orderType,customers.phoneNumbers,payments`,
      undefined,
      options
    );
  }

  async fetchModifiedOrders(merchantId: string, modifiedSince: Date, options: { bucket?: CloverRateBucket } = {}) {
    const filter = encodeURIComponent(`modifiedTime>=${modifiedSince.getTime()}`);
    const expand = "lineItems.modifications,orderType,customers.phoneNumbers,payments";

    // GH #166: Clover's REST API caps a single page at limit=100, so a wide
    // reconciliation window with >100 modified orders previously dropped the
    // tail. Clover paginates by offset (no opaque cursor), so we walk pages of
    // CLOVER_RECON_PAGE_SIZE, advancing `offset` until a short page (or the hard
    // cap) tells us we've consumed everything, then return the concatenated set
    // in the same `{ elements }` shape the single page used to return.
    const elements: JsonRecord[] = [];
    for (let offset = 0; offset < CLOVER_RECON_MAX_ORDERS; offset += CLOVER_RECON_PAGE_SIZE) {
      const page = await this.requestJson(
        merchantId,
        `/v3/merchants/${merchantId}/orders?filter=${filter}&expand=${expand}&limit=${CLOVER_RECON_PAGE_SIZE}&offset=${offset}`,
        undefined,
        options
      );

      const pageElements = Array.isArray(page.elements) ? (page.elements as JsonRecord[]) : [];
      elements.push(...pageElements);

      // A page shorter than the page size is the last page — stop before issuing
      // a needless empty fetch. An exactly-full page means more may remain.
      if (pageElements.length < CLOVER_RECON_PAGE_SIZE) {
        break;
      }
    }

    kdsCloverReconOrdersFetchedTotal.inc({ merchant: merchantId }, elements.length);
    return { elements };
  }

  // Online-ordering menu source (ADR-0027): the merchant's live Clover catalog.
  // Items carry price (cents), availability, categories, and modifier-group refs.
  async fetchMenuItems(merchantId: string, options: { bucket?: CloverRateBucket } = {}) {
    return this.requestJson(
      merchantId,
      `/v3/merchants/${merchantId}/items?expand=categories,modifierGroups&limit=1000`,
      undefined,
      options
    );
  }

  // The modifier groups (+ their modifiers, with per-modifier price) the items
  // reference. Fetched separately and joined, because the item-level
  // `modifierGroups` expansion does not include the nested modifiers.
  async fetchModifierGroups(merchantId: string, options: { bucket?: CloverRateBucket } = {}) {
    return this.requestJson(
      merchantId,
      `/v3/merchants/${merchantId}/modifier_groups?expand=modifiers&limit=1000`,
      undefined,
      options
    );
  }

  // Online ordering: price-quote an ad-hoc cart WITHOUT persisting an order.
  // Clover computes authoritative totals + tax (orderCart.total / .taxTotal),
  // so the customer sees — and is charged — exactly what the order will cost.
  async checkoutAtomicOrder(
    merchantId: string,
    orderCart: Record<string, unknown>,
    options: { bucket?: CloverRateBucket } = {}
  ) {
    return this.requestJson(
      merchantId,
      `/v3/merchants/${merchantId}/atomic_order/checkouts`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orderCart })
      },
      options
    );
  }

  // Create a real, device-visible order. Once it reaches a PAID payment state it
  // fires the O: webhook -> the existing sync pipeline -> the KDS.
  async createAtomicOrder(
    merchantId: string,
    orderCart: Record<string, unknown>,
    options: { bucket?: CloverRateBucket } = {}
  ) {
    return this.requestJson(
      merchantId,
      `/v3/merchants/${merchantId}/atomic_order/orders`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orderCart })
      },
      options
    );
  }

  // Create a customer carrying the checkout phone (drives loyalty accrual; the
  // phone surfaces on the order via expand=customers.phoneNumbers).
  async createCustomer(
    merchantId: string,
    customer: { firstName?: string | undefined; phoneNumber?: string | undefined },
    options: { bucket?: CloverRateBucket } = {}
  ) {
    const body: Record<string, unknown> = {};
    if (customer.firstName) {
      body.firstName = customer.firstName;
    }
    if (customer.phoneNumber) {
      body.phoneNumbers = [{ phoneNumber: customer.phoneNumber }];
    }
    return this.requestJson(
      merchantId,
      `/v3/merchants/${merchantId}/customers`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      },
      options
    );
  }

  async attachCustomerToOrder(
    merchantId: string,
    orderId: string,
    customerId: string,
    options: { bucket?: CloverRateBucket } = {}
  ) {
    return this.requestJson(
      merchantId,
      `/v3/merchants/${merchantId}/orders/${orderId}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ customers: { elements: [{ id: customerId }] } })
      },
      options
    );
  }

  // Record an externally-processed payment on an order. Verified against the
  // Clover sandbox: the order's paymentState flips to PAID (async, ~seconds),
  // which is what lets a web order pass the KDS paid-gate. Tender id comes from
  // the merchant's "External Payment" tender.
  async recordOrderPayment(
    merchantId: string,
    orderId: string,
    payment: { amount: number; tipAmount?: number; tenderId: string },
    options: { bucket?: CloverRateBucket } = {}
  ) {
    const body: Record<string, unknown> = {
      amount: payment.amount,
      tender: { id: payment.tenderId }
    };
    if (payment.tipAmount) {
      body.tipAmount = payment.tipAmount;
    }
    return this.requestJson(
      merchantId,
      `/v3/merchants/${merchantId}/orders/${orderId}/payments`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      },
      options
    );
  }

  // Merchant config used to build + settle online orders: a taxable order type
  // (Clover applies tax only via an order-type reference) and the tenders list
  // (to find the External Payment tender).
  async fetchOrderTypes(merchantId: string, options: { bucket?: CloverRateBucket } = {}) {
    return this.requestJson(
      merchantId,
      `/v3/merchants/${merchantId}/order_types`,
      undefined,
      options
    );
  }

  async fetchTenders(merchantId: string, options: { bucket?: CloverRateBucket } = {}) {
    return this.requestJson(
      merchantId,
      `/v3/merchants/${merchantId}/tenders`,
      undefined,
      options
    );
  }

  async pushTicketFulfillmentEvent(
    ticket: CloverFulfillmentTicketRecord,
    action: KdsAction,
    occurredAt = new Date()
  ) {
    const payload = buildCloverFulfillmentEventPayload(ticket, action, occurredAt);
    if (!payload) {
      return null;
    }

    await this.requestJson(
      ticket.merchantId,
      `/v3/merchants/${ticket.merchantId}/orders/${ticket.sourceOrderId}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "restaurant-ops-platform-KDS/1.0"
        },
        body: JSON.stringify(payload)
      },
      { bucket: "realtime" }
    );

    return payload;
  }

  async requestJson(
    merchantId: string,
    path: string,
    init?: RequestInit,
    options: { bucket?: CloverRateBucket } = {}
  ) {
    const bucket = options.bucket ?? "realtime";
    await this.rateLimiter?.acquire(bucket);
    let merchant = await this.prisma.cloverMerchant.findUnique({ where: { id: merchantId } });
    merchant = await this.maybeRefreshAccessToken(merchant);

    const configuredMerchantId = getConfiguredCloverMerchantId(this.config);
    const configuredToken = getConfiguredCloverToken(this.config);
    // Dual-read the stored token (cipher preferred). A blanked/empty value falls
    // through to the env-configured token, same as a missing merchant row.
    const storedToken = merchant ? resolveCloverMerchantSecrets(merchant).accessToken : "";
    const accessToken = storedToken
      || (configuredMerchantId && merchantId === configuredMerchantId ? configuredToken : undefined);
    if (!accessToken) {
      throw new Error(`No Clover token available for merchant ${merchantId}.`);
    }

    const response = await this.fetchWithRefresh(
      merchantId,
      `${this.config.cloverBaseUrl}${path}`,
      {
        ...init,
        headers: {
          accept: "application/json",
          ...toHeaderObject(init?.headers),
          authorization: `Bearer ${accessToken}`
        }
      },
      bucket
    );

    if (!response.ok) {
      throw new Error(`Clover request failed with ${response.status} for ${path}.`);
    }

    return (await response.json()) as JsonRecord;
  }

  private async fetchWithRefresh(
    merchantId: string,
    url: string,
    init: RequestInit,
    bucket: CloverRateBucket
  ) {
    // Each `cloverFetch()` call below mints its own AbortSignal.timeout(), so
    // the 429/5xx retry loop and the post-refresh retry do NOT stack timeouts.
    let attempt = 0;
    let response = await cloverFetch(url, init, "request");

    while ([429, 500, 502, 503, 504].includes(response.status) && attempt < 3) {
      attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, attempt * 500));
      await this.rateLimiter?.acquire(bucket);
      response = await cloverFetch(url, init, "request_retry");
    }

    if (response.status !== 401) {
      return response;
    }

    const merchant = await this.prisma.cloverMerchant.findUnique({ where: { id: merchantId } });
    if (!merchant || !resolveCloverMerchantSecrets(merchant).refreshToken || !this.config.cloverAppId) {
      return response;
    }

    let refreshedMerchant: CloverMerchant;
    try {
      refreshedMerchant = await this.refreshWithLock(merchant, { allowRecovery: true });
    } catch {
      return response;
    }

    await this.rateLimiter?.acquire(bucket);
    return cloverFetch(
      url,
      {
        ...init,
        headers: {
          ...toHeaderObject(init.headers),
          authorization: `Bearer ${resolveCloverMerchantSecrets(refreshedMerchant).accessToken}`
        }
      },
      "request_retry"
    );
  }

  private async maybeRefreshAccessToken(merchant: CloverMerchant | null) {
    if (!merchant || !resolveCloverMerchantSecrets(merchant).refreshToken || !isExpiringSoon(merchant.tokenExpiresAt)) {
      return merchant;
    }

    try {
      return await this.refreshWithLock(merchant, { allowRecovery: false });
    } catch {
      return merchant;
    }
  }

  private async refreshAccessToken(
    merchant: CloverMerchant,
    options: { allowRecovery: boolean }
  ): Promise<{ merchant: CloverMerchant; outcome: CloverRefreshOutcome }> {
    if (!this.config.cloverAppId) {
      throw new Error("CLOVER_APP_ID is required to refresh Clover access tokens.");
    }

    // Dual-read the current secrets once (cipher preferred); reuse for the
    // request bodies, the parseTokenSet carry-forward fallback, and the
    // recovery-token rotation below.
    const secrets = resolveCloverMerchantSecrets(merchant);

    // Encrypt the rotated token set at rest in the *Cipher columns (plaintext
    // columns dropped in 20260618_drop_pos_token_plaintext). recoveryToken carries
    // forward the PREVIOUS secret (Clover's rotation contract): the old refresh
    // token after a refresh, the old recovery token after a recovery.
    const buildTokenColumns = (tokens: CloverTokenSet, recoveryPlaintext: string | null) => ({
      accessTokenCipher: encryptSecretForStorage(tokens.accessToken),
      refreshTokenCipher: encryptSecretForStorage(tokens.refreshToken),
      tokenExpiresAt: tokens.accessTokenExpiresAt,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
      recoveryTokenCipher: encryptSecretForStorage(recoveryPlaintext),
      authStatus: MerchantAuthStatus.ACTIVE,
      region: this.config.cloverRegion
    });

    const refreshResponse = await cloverFetch(
      `${getCloverApiOrigin(this.config.cloverBaseUrl)}/oauth/v2/refresh`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json"
        },
        body: JSON.stringify({
          client_id: this.config.cloverAppId,
          refresh_token: secrets.refreshToken
        })
      },
      "refresh"
    );

    if (refreshResponse.ok) {
      const payload = (await refreshResponse.json()) as JsonRecord;
      const tokens = parseTokenSet(payload, {
        accessToken: secrets.accessToken,
        refreshToken: secrets.refreshToken
      });

      await this.prisma.cloverMerchant.update({
        where: { id: merchant.id },
        data: buildTokenColumns(tokens, secrets.refreshToken)
      });

      const refreshed = await this.prisma.cloverMerchant.findUniqueOrThrow({ where: { id: merchant.id } });
      return { merchant: refreshed, outcome: "success" };
    }

    const recoveryAvailable = options.allowRecovery
      && secrets.recoveryToken
      && this.config.cloverAppSecret
      && readResponseHeader(refreshResponse, "x-clover-recovery-available") === "true";

    if (recoveryAvailable) {
      const recoveryResponse = await cloverFetch(
        `${getCloverApiOrigin(this.config.cloverBaseUrl)}/oauth/v2/recovery`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json"
          },
          body: JSON.stringify({
            client_id: this.config.cloverAppId,
            client_secret: this.config.cloverAppSecret,
            recovery_token: secrets.recoveryToken
          })
        },
        "recovery"
      );

      if (recoveryResponse.ok) {
        const payload = (await recoveryResponse.json()) as JsonRecord;
        const tokens = parseTokenSet(payload, {
          accessToken: secrets.accessToken,
          refreshToken: secrets.refreshToken
        });

        await this.prisma.cloverMerchant.update({
          where: { id: merchant.id },
          data: buildTokenColumns(tokens, secrets.recoveryToken)
        });

        const recovered = await this.prisma.cloverMerchant.findUniqueOrThrow({ where: { id: merchant.id } });
        return { merchant: recovered, outcome: "recovery" };
      }
    }

    await this.prisma.cloverMerchant.update({
      where: { id: merchant.id },
      data: {
        authStatus: MerchantAuthStatus.ERROR
      }
    });

    throw new Error(`Unable to refresh Clover auth for merchant ${merchant.id}.`);
  }

  private async refreshWithLock(
    merchant: CloverMerchant,
    options: { allowRecovery: boolean }
  ): Promise<CloverMerchant> {
    if (!this.rateLimiter) {
      const { merchant: refreshed } = await this.refreshAccessToken(merchant, options);
      return refreshed;
    }

    // GH #134: time the whole locked refresh (lock wait excluded — the lock is
    // already held here) and log the outcome so on-call can spot a slow-network
    // refresh that is creeping toward the lock TTL, plus distinguish a duplicate
    // refresh (`noop`) from a real one.
    const startedAt = Date.now();
    // Defaults to "error"; the success path overwrites it with the real outcome,
    // and the catch path narrows it to "timeout" only for a CloverTimeoutError —
    // every other failure keeps this "error" default.
    let outcome: CloverRefreshOutcome = "error";
    try {
      const result = await this.rateLimiter.withMerchantLock(merchant.id, async () => {
        const current = await this.prisma.cloverMerchant.findUnique({ where: { id: merchant.id } });
        if (!current) {
          return this.refreshAccessToken(merchant, options);
        }

        const currentSecrets = resolveCloverMerchantSecrets(current);

        // Another holder already rotated the token while we waited for the lock:
        // skip the redundant Clover call and reuse the fresh record. Compare the
        // DECODED tokens — encrypted rows blank the plaintext column to "", so a
        // raw column compare would read "" !== "" and miss the rotation.
        if (options.allowRecovery && currentSecrets.accessToken !== resolveCloverMerchantSecrets(merchant).accessToken) {
          return { merchant: current, outcome: "noop" as const };
        }

        if (!options.allowRecovery && (!currentSecrets.refreshToken || !isExpiringSoon(current.tokenExpiresAt))) {
          return { merchant: current, outcome: "noop" as const };
        }

        return this.refreshAccessToken(current, options);
      });
      outcome = result.outcome;
      return result.merchant;
    } catch (error) {
      if (error instanceof CloverTimeoutError) {
        outcome = "timeout";
      }
      throw error;
    } finally {
      const durationSeconds = (Date.now() - startedAt) / 1000;
      kdsCloverTokenRefreshDurationSeconds.observe({ merchant: merchant.id, outcome }, durationSeconds);
      const fields = { merchantId: merchant.id, outcome, durationSeconds };
      if (outcome === "error" || outcome === "timeout") {
        this.logger.warn(fields, "Clover token refresh did not complete.");
      } else {
        this.logger.info(fields, "Clover token refresh completed.");
      }
    }
  }
}
