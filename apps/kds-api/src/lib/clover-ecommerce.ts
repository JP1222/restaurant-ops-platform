import type { AppConfig } from "../config.js";
import { cloverFetch } from "./clover-client.js";

/**
 * Clover **Ecommerce** API client — online card payments (ADR-0027).
 *
 * This is deliberately SEPARATE from {@link CloverClient} (the Platform REST
 * v3 client). The two differ on both axes:
 *
 *  - **Host**: charges hit `scl.clover.com` (sandbox `scl-sandbox.dev.clover.com`),
 *    NOT `api.clover.com`. Config-driven via `config.cloverEcommApiBaseUrl`.
 *  - **Auth**: a static merchant ECOMMERCE *private* key as `Authorization:
 *    Bearer`, NOT the per-merchant OAuth access token.
 *
 * Card data never reaches us: the browser tokenizes the card in Clover's hosted
 * iframe (public key) to an opaque `clv_…` token; we only ever charge that
 * token here (SAQ-A). Verified end-to-end against the Clover sandbox 2026-05-31
 * — see docs/design/online-ordering/clover-integration-recipe.md.
 */

export interface CloverChargeInput {
  /** Amount to capture, in the currency's minor unit (cents for USD). */
  amountCents: number;
  /** ISO 4217 currency, lower-case (e.g. "usd"). */
  currency: string;
  /** The opaque single-use `clv_…` token minted by the hosted iframe. */
  sourceToken: string;
  /**
   * Idempotency key — derive it deterministically from the checkout session
   * (NOT a fresh uuid per attempt) so a client retry can never double-charge.
   */
  idempotencyKey: string;
  /**
   * The customer's IP, forwarded from the order-web request. Clover REQUIRES
   * `x-forwarded-for` on charges (verified — the charge is rejected without it).
   */
  clientIp: string;
}

export interface CloverChargeResult {
  /** Clover charge id (e.g. "XBJJ36WY74YAM"). Safe to log. */
  id: string;
  /** Clover charge status, e.g. "succeeded". */
  status: string;
  /** Whether Clover captured funds. */
  paid: boolean;
  /** Captured amount echoed by Clover, in minor units. */
  amountCents: number;
}

/**
 * Thrown when a charge call returns a non-2xx. Carries the HTTP status only —
 * never the response body, which may contain card/charge detail.
 */
export class CloverEcommerceError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Clover Ecommerce charge failed with status ${status}.`);
    this.name = "CloverEcommerceError";
    this.status = status;
  }
}

export class CloverEcommerceClient {
  constructor(private readonly config: AppConfig) {}

  /** Whether the private key needed to charge is configured. */
  get configured(): boolean {
    return Boolean(this.config.cloverEcommPrivateKey);
  }

  /** The browser-side public (tokenization) key, if configured. */
  get publicKey(): string | undefined {
    return this.config.cloverEcommPublicKey;
  }

  /**
   * Charge an already-tokenized card (`POST /v1/charges`). The caller decides
   * policy from the result (e.g. require `paid === true`); this method only
   * performs the HTTP call. Throws {@link CloverEcommerceError} on a non-2xx
   * and a plain Error when the private key is unconfigured.
   */
  async charge(input: CloverChargeInput): Promise<CloverChargeResult> {
    const privateKey = this.config.cloverEcommPrivateKey;
    if (!privateKey) {
      throw new Error(
        "Clover Ecommerce is not configured (CLOVER_ECOMM_PRIVATE_KEY is unset).",
      );
    }

    const response = await cloverFetch(
      `${this.config.cloverEcommApiBaseUrl}/v1/charges`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${privateKey}`,
          // Deterministic per checkout — see CloverChargeInput.idempotencyKey.
          "idempotency-key": input.idempotencyKey,
          // REQUIRED by Clover; the customer's IP forwarded from order-web.
          "x-forwarded-for": input.clientIp,
        },
        body: JSON.stringify({
          amount: input.amountCents,
          currency: input.currency,
          source: input.sourceToken,
          ecomind: "ecom",
          capture: true,
        }),
      },
      "ecommerce_charge",
    );

    if (!response.ok) {
      // Surface status only — the body can carry card/charge detail.
      throw new CloverEcommerceError(response.status);
    }

    const data = (await response.json()) as {
      id?: unknown;
      status?: unknown;
      paid?: unknown;
      amount?: unknown;
    };

    return {
      id: typeof data.id === "string" ? data.id : "",
      status: typeof data.status === "string" ? data.status : "unknown",
      paid: data.paid === true,
      amountCents: typeof data.amount === "number" ? data.amount : input.amountCents,
    };
  }

  /**
   * Refund a charge in full — compensation when the Clover order cannot be
   * created/settled after a successful charge, so a customer is never charged
   * for an order that never reaches the kitchen.
   */
  async refund(chargeId: string): Promise<{ id: string; status: string }> {
    const privateKey = this.config.cloverEcommPrivateKey;
    if (!privateKey) {
      throw new Error(
        "Clover Ecommerce is not configured (CLOVER_ECOMM_PRIVATE_KEY is unset).",
      );
    }

    const response = await cloverFetch(
      `${this.config.cloverEcommApiBaseUrl}/v1/refunds`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${privateKey}`,
        },
        body: JSON.stringify({ charge: chargeId }),
      },
      "ecommerce_refund",
    );

    if (!response.ok) {
      throw new CloverEcommerceError(response.status);
    }

    const data = (await response.json()) as { id?: unknown; status?: unknown };
    return {
      id: typeof data.id === "string" ? data.id : "",
      status: typeof data.status === "string" ? data.status : "unknown",
    };
  }
}
