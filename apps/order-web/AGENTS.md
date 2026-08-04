# apps/order-web

Customer-facing **online ordering** web app for the EXAMPLE KITCHEN ice-cream shop. A phone-first flow: a customer scans a QR code (or follows the "Order online" link from [`apps/marketing-site`](../marketing-site/AGENTS.md)), browses the menu, builds a roll, and pays — pickup at Anytown.

This app is **distinct from** the other web surfaces:

```
            ┌─ marketing-site (static)  →  public storefront, links here
Order-web ──┤
(customer)  └─ order-web (this app)     →  customer builds + pays for an order
                       │ creates a paid order in the POS
                       ▼
KDS API ────┬─ kds-web / iOS            →  kitchen sees the ticket
            └─ crew-web                 →  line records waste / 86
```

It is **not** a Floor product (kitchen) and **not** Backoffice (owner/manager). It is the customer's own ordering surface — see Iron Law #4 in the [root AGENTS.md](../../AGENTS.md).

## Status: sandbox-verified end-to-end (2026-06-02); production live-pay pending (`NEXT_PUBLIC_CLOVER_*` + rebuild)

Ported from the standalone `example-org/online-ordering` repo (Vite SPA) into the suite's stack. The ordering backend exists in `kds-api` (public `/api/order/*`, PR1–PR3c — see the handoff), and the **entire** `lib/api.ts` surface now talks to it through same-origin BFF route handlers under [`app/api/order/*`](app/api/order):

- `getMenu` — merchant's live Clover catalog (dev-only MOCK fallback).
- `getQueueEstimate` — labeled `fallback` (no real estimate endpoint yet).
- `createOrder` / `checkout` / `getOrderStatus` — draft pricing, the Clover hosted-iframe charge, and lifecycle polling.

⚠️ **Production live-pay pending:** the Clover card iframe ([`lib/clover-sdk.ts`](lib/clover-sdk.ts)) was **sandbox-verified in a real browser 2026-06-02** (iframe renders + tokenizes; charge → order → PAID → KDS → loyalty); a production-key live charge against the real merchant is still pending. It needs `NEXT_PUBLIC_CLOVER_ECOMM_PUBLIC_KEY` + `NEXT_PUBLIC_CLOVER_MERCHANT_ID`; until set, Checkout shows a graceful "payment not configured" state.

Same "frontend prototype, swap one layer" pattern as [`apps/crew-web`](../crew-web/AGENTS.md).

## Stack

- Next.js 16 + React 19 + Tailwind v4 (PostCSS plugin, CSS-first theme in [`app/globals.css`](app/globals.css) — no `tailwind.config.js`). **Own custom, brand-led components — NOT shadcn/ui** (that's the back-office app).
- `zustand` for the cart (localStorage-persisted). Motion is CSS (the `.press` / `.sheet` / `.tracker` keyframes in `globals.css`); `framer-motion` stays a dep for future transitions.
- **Fonts (the "Berry" brand — do NOT swap to Plus Jakarta / Inter / system):** Bagel Fat One (wordmark), Caprasimo (display/headings), DM Sans (body/UI/buttons), Geist Mono (eyebrows/meta) via `next/font/local`, vendored as woff2 under [`app/fonts/`](app/fonts) (self-hosted so `next build` stays hermetic — no `fonts.googleapis.com` dependency) → CSS vars `--font-{bagel,caprasimo,dmsans,geistmono}`.
- **Design system — the "Berry" handoff** ([`docs/design/order-web-design-brief.md`](../../docs/design/order-web-design-brief.md) + a Claude Design developer handoff, landed as a full redesign): `globals.css` holds the `@theme` `--color-*` tokens, the chunky `sticker`/`press` utilities, and the ported component recipes (`.btn` `.icard` `.opt` `.tracker` `.cartbar` …). Brand visuals (`Wordmark` / `RollCup` / `BobaCup` / `Stepper` / `Confetti`) live in [`components/brand-visuals.tsx`](components/brand-visuals.tsx); the centerpiece [`components/ItemBuilder.tsx`](components/ItemBuilder.tsx) + the screens consume real kds-api data through [`lib/menu-adapter.ts`](lib/menu-adapter.ts), which derives kind/tint/badge/flavor-color/control-type and **degrades gracefully** on the sparse live catalog (no tag → no badge, etc.). Mobile vs desktop layout is the `.yr.m` / `.yr.d` mode class set from `useIsDesktop()` ([`lib/hooks.ts`](lib/hooks.ts)) — real viewport, not media queries. Visual sibling of `marketing-site`.

## Routes (App Router)

| Route | Page | Purpose |
| --- | --- | --- |
| `/` | Welcome | QR landing / start order |
| `/menu` | Menu | category tabs (scroll-jump), item cards, full-screen item builder; mobile cart bar / desktop cart sidebar |
| `/cart` | Cart | review lines, qty steppers, remove, est. totals |
| `/checkout` | Checkout | single-scroll: pickup info + tip + **in-page Clover hosted-iframe** card → `createOrder` → charge |
| `/confirmation` | Confirmation | post-payment status, polls order status |
| `/confirmation/[orderId]` | Confirmation | post-payment status for a specific order — Checkout redirects here after charge; polls order status by id |

Dropped from the source repo on purpose: its own `Kds` page (the suite has a real KDS), `TVDisplay`, and `MockCheckout`. `Location` (leaflet mall map) may be ported later but overlaps marketing-site's "Visit" section.

## Rules

- **The API boundary stays POS-neutral.** [`lib/api.ts`](lib/api.ts) exposes `getMenu` / `createOrder` / `getOrderStatus` over neutral DTOs ([`lib/types.ts`](lib/types.ts)) — **no Clover-specific fields** leak into the UI. The suite is moving toward a heterogeneous-POS abstraction (Clover/Square/Toast), and this frontend must not care which POS is underneath. When the real backend lands, only this file changes; ideally its DTOs migrate into `packages/contracts`.
- **Card handling is Clover's hosted iframe — never our own fields.** Decided payment path ([ADR-0027](../../docs/decisions/0027-clover-online-payment-and-order-bridge.md)) is Clover Ecommerce **hosted iframe / Elements** — card fields are Clover iframes ON this page (customer stays in the builder), the browser tokenizes to a `clv_` token, and **card data never touches our server (SAQ-A class)**. After the charge, `kds-api` creates a Clover **Atomic Order** to surface it on the KDS. The iframe is now implemented ([`lib/clover-sdk.ts`](lib/clover-sdk.ts) + [`components/screens/Checkout.tsx`](components/screens/Checkout.tsx)); the one remaining PCI follow-up is the CSP `script-src` allowlist for `checkout*.clover.com` (PCI v4.0 §6.4.3/§11.6.1 — tracked in Follow-ups below).
- **Do not import `@rop/db-kds`** (Iron Law #1/#4, lint-enforced). This app talks to the ordering API over HTTP; it never touches a database client.
- **No customer PII persisted client-side** beyond the cart + the pickup name in the in-flight order. No analytics/tracking scripts (same posture as marketing-site).
- **Keep it phone-first.** The primary device is a customer's phone after a QR scan. Test narrow viewports first.
- **Single-store today, by design.** Pickup is Anytown (store #1) and the app bakes one `NEXT_PUBLIC_CLOVER_MERCHANT_ID` at build. A store picker → per-store merchant id is a deliberately-deferred multi-location item — don't assume multi-store here, and don't add new single-merchant build-time coupling without reading [docs/multi-location.md](../../docs/multi-location.md). (kds-api's `/api/order/*` already 503s a non-default / Square store, so store #2 ordering is fail-closed, not mis-routed.)

## Commands

```bash
pnpm --filter @rop/order-web dev        # http://localhost:3004
pnpm --filter @rop/order-web build
pnpm --filter @rop/order-web lint
pnpm --filter @rop/order-web typecheck
pnpm --filter @rop/order-web test       # vitest — BFF route-handler unit tests (tests/)
```

## Migration path

`lib/api.ts` talks to same-origin BFF route handlers under [`app/api/order/*`](app/api/order) (mirroring crew-web's [`lib/server/inventory-api.ts`](../crew-web/lib/server/inventory-api.ts)), which forward to kds-api's public `/api/order/*` and own the **dollars↔cents** conversion ([`lib/money.ts`](lib/money.ts)) — contracts are integer cents, this UI is dollars. Checkout is **two steps on one page**: `createOrder` prices a draft, then Clover's hosted card iframe ([`lib/clover-sdk.ts`](lib/clover-sdk.ts)) tokenizes the card to an opaque `clv_` token (sent to the BFF as a neutral `paymentToken` — never a Clover-named field) and `checkout` charges it. The charge BFF forwards the customer's IP as `x-forwarded-for` (Clover rejects the charge without it). The paid order reaches the KDS **because kds-api creates a Clover Atomic Order after the charge** — that order then fires the existing Clover order-webhook → `syncOrderById` pipeline ([ADR-0027](../../docs/decisions/0027-clover-online-payment-and-order-bridge.md); it does **not** auto-flow). This app never writes to a KDS database.

**Follow-ups (not in PR5b):** tip selector, Apple/Google Pay, loyalty enrollment, gift cards (design-brief §7.5/§7.7/§7.8, Phase 2/3); and a CSP `script-src` allowlist for `checkout*.clover.com` (PCI v4.0 §6.4.3/§11.6.1 — `sdk.js` already loads only from Clover's origin, but the CSP control belongs in next.config headers).
