# ADR-0027: Clover online payment via hosted iframe + an Atomic-Order bridge to the KDS

- **Status**: Proposed
- **Date**: 2026-05-31
- **Deciders**: @example-org
- **Refines**: [ADR-0025](0025-online-ordering-architecture.md) (which deferred the payment decision and assumed "Hosted Checkout redirect" + that a paid online order "flows into the same kds-api pipeline" automatically — both corrected below)
- **Grounded in**: a 2026-05-31 research pass against developer.clover.com / docs.clover.com. Fees + API details decay — re-verify in the Clover sandbox before building.

## Context

`apps/order-web` (the customer ordering site) is a prototype on mock data; making it real needs a payment integration. [ADR-0025](0025-online-ordering-architecture.md) deferred that to "its own ADR" and tentatively assumed **Clover Hosted Checkout (redirect)** with the paid order **auto-flowing** into the existing Clover-webhook → `syncOrderById` → KDS pipeline. Research corrected two load-bearing assumptions:

1. **No Clover online-payment path makes a paid web order automatically appear on Clover devices or fire the app-level `O:` (orders) webhook the KDS sync consumes.** Clover treats *payment acceptance* and *device-visible orders* as **two separate systems**:
   - Ecommerce `/v1/charges` creates only a minimal **payment-side** order; Clover's docs state orders not created via **Create an Atomic Order** "do not display on the Merchant Dashboard and devices."
   - Hosted Checkout fires only its **own** `PAYMENT`-type webhook on a separate Dashboard channel, keyed by Checkout-Session UUID — **not** the app-level `O:` webhook our pipeline listens to.
   - **The only way to light up the existing webhook → sync → KDS path is to call `POST /v3/merchants/{mId}/atomic_order/orders` (Create an Atomic Order) with inventory-linked line items after payment.** This glue is mandatory on every path.

2. **A redirect (Hosted Checkout) breaks the in-page UX of a custom "build a roll" builder**, and the hosted page's customer object is per-transaction (can't link a Clover customer). An **iframe/Elements** card capture keeps the customer on our Next.js page at the same PCI scope.

PCI scope by capture method (Clover rates these qualitatively; the literal SAQ letters are from PCI SSC, not Clover-stamped): **redirect ≈ SAQ-A**, **iframe/Elements ≈ SAQ-A / SAQ-A-EP** (card never touches our server — we only ever see a `clv_` token), **raw PAN to our server = SAQ-D** (avoid).

## Decision

**Card capture via Clover Ecommerce hosted iframe/Elements; create a Clover Atomic Order after payment to bridge into the existing KDS pipeline.** Concretely:

1. **Payment = Clover Ecommerce API with the hosted iframe (`checkout.clover.com/sdk.js`, Elements).** Card fields are Clover iframes on the order-web checkout page; the browser tokenizes to a `clv_` token; our backend charges via `POST /v1/charges` (`x-forwarded-for` required). **Card data never touches our server → SAQ-A class.** The customer stays on the order-web page (preserves the custom builder UX). "Rent the rails" — we never store stored value or raw PAN.
2. **Order-creation glue lives in `kds-api`** (it owns Clover credentials + the order pipeline — Iron Law). After a successful charge, kds-api calls **Create an Atomic Order** with the cart's inventory-linked line items + the customer (name/phone). That order then fires the **normal `O:` webhook**, which the existing `provider-ingress → normalizeOrder → syncOrderById → KDS` path already handles with **zero new sync code**. order-web never writes to a KDS db (ADR-0025).
3. **Loyalty attribution rides this bridge.** The phone captured at checkout is attached to the Atomic Order's customer → surfaces on the `NormalizedOrder` → drives accrual (ADR-0022/4a). This is exactly how "online orders earn" (owner decision, 2026-05-31): online orders carry a customer/phone, in-store orders (no attached customer) skip as anonymous — no special-casing.
4. **Refunds via the order-based return** (`POST /v1/orders/{orderId}/returns`, supports partial), **not** charge-based `/v1/refunds` (no partial when the charge has tax/tip/multiple lines). A refund fires the order webhook → the accrual REVERSE path (4a) runs.
5. **PCI obligations beyond SAQ-A:** PCI DSS v4.0 §6.4.3 + §11.6.1 (payment-page script integrity / anti-skimming) apply to the order-web checkout page even with the iframe — a launch-checklist item (script inventory + tamper detection on the page that hosts the Clover iframe).

## Consequences

- A clean, low-PCI online-payment path that keeps the custom builder UX and **reuses the entire existing Clover→KDS sync pipeline** — at the cost of one mandatory piece of glue (the post-payment Atomic-Order create in kds-api). The ADR-0025 "auto-flow" assumption is replaced by this explicit bridge.
- Unified Clover settlement + reporting (in-store + online in one processor); fees ~3.5% + $0.10 CNP, within a few cents of Stripe on a small ticket (Clover slightly cheaper under ~$33 due to the lower fixed fee).
- kds-api gains: an order-draft/charge surface + an Atomic-Order writer + handling the Ecommerce/HCO payment webhook. order-web gains: the iframe checkout + same-origin BFF calls (swap its mock `lib/api.ts`). The ordering DTOs migrate to `packages/contracts` when these endpoints land (ADR-0025).
- The customer-attach-to-Atomic-Order mechanism and exact fees/SAQ mapping must be **confirmed in the Clover sandbox** before locking the build (flagged decaying items below).

## Alternatives considered

- **Hosted Checkout (redirect).** Rejected as the primary: lowest effort + SAQ-A, but the off-site redirect breaks a custom multi-step builder, its customer object can't link a Clover customer, and it still requires the Atomic-Order bridge for KDS. (Kept as a fallback if the iframe integration proves too costly.)
- **Direct Ecommerce API (raw PAN to our server).** Rejected: SAQ-D / full PCI DSS certification — disproportionate for a single small merchant.
- **Stripe.** Materially better DX + SAQ-A, fees a wash, **but** online orders don't flow into Clover at all (no Clover order, no unified settlement/reporting, no device/KDS) — you'd *still* push Atomic Orders to Clover for the KDS, so you pay the glue cost anyway AND split settlement across two processors. Rejected for a Clover-anchored single-merchant shop; revisit if a non-Clover store appears.
- **Clover's first-party "Online Ordering" product.** Rejected: no developer API to embed it in a custom Next.js site; it locks ordering into Clover's hosted UI/subdomain — the opposite of the owned customer surface in ADR-0025.

## Decaying / unconfirmed (verify in sandbox before building)

- **Fees** (Clover CNP 3.5% + $0.10; Stripe 2.9% + $0.30) — third-party/aggregator figures; confirm the merchant's negotiated rate.
- **SAQ-letter mapping per capture method** — from PCI SSC + a Clover community staff thread, not literally printed in Clover docs.
- **`x-forwarded-for` now required on charges; no GET endpoint for HCO session status (webhooks only); current SDK/host URLs** — accurate today, Clover changes these.
- **Exact mechanism to attach a Clover Customer (with `phoneNumber`) to an Atomic Order** so it surfaces on the normalized order for loyalty — confirm in sandbox; this is load-bearing for "online orders earn."

## Future work (out of scope here)

- The `kds-api` `/api/order/*` endpoints (draft/charge/atomic-order create) + the ordering DTOs in `packages/contracts`.
- The order-web iframe checkout + BFF wiring (swap mock `lib/api.ts`).
- The PCI v4.0 §6.4.3/§11.6.1 script-integrity checklist for the checkout page.
