"use client";

/**
 * Clover hosted-iframe Web SDK loader — the ONE place this app knows about
 * Clover. Everything downstream (lib/api.ts, the BFF) sees only an opaque
 * `clv_…` token via a neutral `paymentToken`, per the design brief's
 * "PaymentService abstraction — don't hard-assume Clover beyond the hosted
 * field" (docs/design/order-web-design-brief.md §13) + Iron Law #4.
 *
 * Card data lives only inside Clover's iframes — the PAN never touches our JS
 * or our server (SAQ-A). The browser tokenizes the card and hands us only the
 * token.
 *
 * ⚠️ UN-VERIFIED IN-BROWSER: the recipe doc verified the raw token *endpoint* +
 * public key, but the sdk.js widget itself has not yet been exercised in a real
 * browser (docs/design/online-ordering/clover-integration-recipe.md, "Verified
 * vs still-assumed"). This module follows Clover's documented API
 * (docs.clover.com/dev/docs/using-the-clover-hosted-iframe); confirm against a
 * live sandbox key before trusting it with real cards.
 *
 * PCI DSS v4.0 §6.4.3 / §11.6.1 (payment-page script integrity + tamper
 * detection): sdk.js is loaded only from Clover's official origins below. A CSP
 * `script-src` allowlist for `checkout*.clover.com` is the remaining control —
 * tracked as a hardening follow-up (belongs in next.config headers), NOT done
 * here.
 */

// ── Minimal typings for sdk.js (no official @types). Only what we touch. ──
type CloverElementType = "CARD_NUMBER" | "CARD_DATE" | "CARD_CVV" | "CARD_POSTAL_CODE";

interface CloverElement {
  mount(selector: string): void;
}
interface CloverElements {
  create(type: CloverElementType, styles?: unknown): CloverElement;
}
interface CloverTokenResult {
  token?: string; // clv_… on success
  errors?: Record<string, { error?: string; touched?: boolean } | undefined>;
}
interface CloverSdk {
  elements(): CloverElements;
  createToken(): Promise<CloverTokenResult | null>; // null is possible (AVS)
}
interface CloverConstructor {
  new (apiAccessKey: string, opts: { merchantId: string; locale?: string }): CloverSdk;
}
declare global {
  interface Window {
    Clover?: CloverConstructor;
  }
}

const SDK_SRC = {
  sandbox: "https://checkout.sandbox.dev.clover.com/sdk.js",
  production: "https://checkout.clover.com/sdk.js",
} as const;

export interface CloverPaymentConfig {
  publicKey: string;
  merchantId: string;
  env: "sandbox" | "production";
}

/**
 * Read the (browser-safe) Clover config from public env. Returns null when
 * unset — the only Clover values allowed client-side are the publishable key +
 * the merchant id (both non-secret). Until they're provided, Checkout shows a
 * "payment not configured" state instead of a broken iframe.
 */
export function readCloverConfig(): CloverPaymentConfig | null {
  const publicKey = process.env.NEXT_PUBLIC_CLOVER_ECOMM_PUBLIC_KEY;
  const merchantId = process.env.NEXT_PUBLIC_CLOVER_MERCHANT_ID;
  if (!publicKey || !merchantId) return null;
  const env = process.env.NEXT_PUBLIC_CLOVER_ENV === "production" ? "production" : "sandbox";
  return { publicKey, merchantId, env };
}

// DOM mount points the card form must render before mountCloverCard() runs.
export const CARD_FIELD_IDS = {
  number: "clover-card-number",
  date: "clover-card-date",
  cvv: "clover-card-cvv",
  postal: "clover-card-postal",
} as const;

let sdkPromise: Promise<void> | null = null;

function loadSdk(env: "sandbox" | "production"): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Clover SDK is browser-only"));
  }
  if (window.Clover) return Promise.resolve();
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SDK_SRC[env];
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      sdkPromise = null; // allow a retry
      reject(new Error("Could not load the payment form."));
    };
    document.head.appendChild(script);
  });
  return sdkPromise;
}

export interface MountedCloverCard {
  /** Tokenize the entered card → opaque clv_ token, or a customer-safe error. */
  createToken(): Promise<{ token: string } | { error: string }>;
}

/**
 * Load sdk.js, init Clover, and create + mount the four card elements into the
 * CARD_FIELD_IDS mount points (which must already be in the DOM). Returns a
 * handle whose createToken() yields an opaque token or a friendly error.
 */
export async function mountCloverCard(config: CloverPaymentConfig): Promise<MountedCloverCard> {
  await loadSdk(config.env);
  const Clover = window.Clover;
  if (!Clover) throw new Error("Could not load the payment form.");

  const clover = new Clover(config.publicKey, { merchantId: config.merchantId });
  const elements = clover.elements();
  // Inherit page styling for now; per-field brand polish is a follow-up.
  const styles = {};
  elements.create("CARD_NUMBER", styles).mount(`#${CARD_FIELD_IDS.number}`);
  elements.create("CARD_DATE", styles).mount(`#${CARD_FIELD_IDS.date}`);
  elements.create("CARD_CVV", styles).mount(`#${CARD_FIELD_IDS.cvv}`);
  elements.create("CARD_POSTAL_CODE", styles).mount(`#${CARD_FIELD_IDS.postal}`);

  return {
    async createToken() {
      const result = await clover.createToken();
      if (result && result.token) return { token: result.token };
      // createToken can resolve to null (e.g. AVS rules + missing/invalid
      // postal) or carry per-field errors. Surface the first useful message.
      const firstError = result?.errors
        ? Object.values(result.errors).find((e) => e?.error)?.error
        : undefined;
      return { error: firstError ?? "Please check your card details and try again." };
    },
  };
}
