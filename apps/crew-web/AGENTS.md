# apps/crew-web

Kitchen-Floor inventory app for Spanish-speaking line cooks. PIN-login → record waste, receive deliveries, view the 86 list, run quick re-counts. Optimised for shared iPad / phone at the prep station, not for desktop.

This app is **distinct from** [`apps/kds-web`](../kds-web/AGENTS.md) (kitchen display showing tickets) and [`apps/backoffice-web`](../backoffice-web/AGENTS.md) (owner/manager admin). It is the third leg of the Floor surface story:

```
            ┌─ Backoffice (web)     →  owner / manager
KDS API ────┤─ KDS (web/iPad)       →  line sees tickets
            └─ Crew (iPad/phone)    →  line records waste / receives / 86
```

The split exists because the backoffice session model (8h personal login + sensitive vendor pricing + P&L) is incompatible with shared kitchen devices (20+ people through one iPad per day, 6-digit PIN, single-task sessions). See the Iron Law #4 entry in the [root AGENTS.md](../../AGENTS.md).

## Stack

- Next.js 16 + React 19 + Tailwind v4 (PostCSS plugin, CSS-driven theme — no `tailwind.config.js`).
- No shadcn/ui, no framer-motion, no auth deps. The design is raw Tailwind with inline SVG icons; pulling in shadcn would override the visual language.
- Inter + JetBrains Mono via `next/font/local`, vendored under [`app/fonts/`](app/fonts) (matches backoffice typography; self-hosted so `next build` stays hermetic — no `fonts.googleapis.com` dependency).
- Inventory data + crew PIN auth come from `apps/inventory-api` via crew-web's own BFF route handlers under [`app/api/*`](app/api). The browser only calls same-origin `/api/*`; those handlers forward to inventory-api and own the httpOnly crew session cookie. The fetched dataset is shared through a small React context ([`lib/crew-data.tsx`](lib/crew-data.tsx)); the browser-side fetch wrappers live in [`lib/api.ts`](lib/api.ts). (The former inline `lib/data.ts` and `lib/employees.ts` PIN fixtures were removed when real auth landed — `lib/employees.ts` now holds only display glyphs.)

## What's here

The home + screen model was reorganised per a design handoff (see [ADR-0538](../../docs/decisions/0538-ai-invoice-scan-for-receiving-via-deepseek-vision.md) for the invoice-scan backend it builds on). Home groups into **Movimientos** (Escanear factura / Recibir / Merma / Reconteo) and **Catálogo** (Artículos). The old stand-alone **86 / Add item / Edit item** screens are subsumed by the Artículos catalog (item detail consolidates 86 / recount / waste; "＋ Nuevo" + Editar live there).

| Surface | File | Purpose |
| --- | --- | --- |
| Login | [`components/pin-login.tsx`](components/pin-login.tsx) | 6-digit PIN keypad (phone = single column, tablet/desktop = brand + keypad split). The login BFF route enforces a manager-set **IP allowlist** ([`lib/server/crew-ip-gate.ts`](lib/server/crew-ip-gate.ts)) — crew-web is the only tier that sees the cook's real IP (Traefik `X-Forwarded-For`), since inventory-api is internal-only. Empty list = allow all. |
| Home | [`components/home-screen.tsx`](components/home-screen.tsx) | Two labeled groups: **Movimientos** (full-width violet *Escanear factura* hero + Recibir / Merma / Reconteo tiles, Recibir badge = open-PO count) and **Catálogo** (dark *Artículos* tile with live `{n} artículos` / `{n} crítico` counts). Badges stay fresh: crew-app polls the dataset every 60s while parked on home (+ on wake via `visibilitychange`), and the greeting row has a manual refresh button |
| Scan | [`components/scan-flow.tsx`](components/scan-flow.tsx) | **AI invoice scan** (ADR-0538): capture → analyzing → human-review → import. Capture has two distinct inputs — **Tomar foto** (camera, `capture="environment"`) and **Subir archivo** (file picker, *no* `capture` so it never forces the camera) accepting **PDF + PNG/JPEG/WebP**. A PDF's first page is rendered to a JPEG client-side ([`lib/pdf.ts`](lib/pdf.ts), `pdfjs-dist`, lazy-imported + worker bundled same-origin) so every input reaches the pipeline as an image. Review is an editable line table (qty steppers, include toggles, price-change chips, new-SKU inline-create forms); confirm calls the real ad-hoc receive (`POST /api/inventory/receive`) + per-line reprice. OCR extraction posts to [`app/api/inventory/scan`](app/api/inventory/scan/route.ts), which **proxies the image to backoffice's `/api/inventory/receipt-parse` (AI vision — Google Gemini; DeepSeek has no image API)** over the shared net with an `INTERNAL_AI_TOKEN` bearer — crew-web has no AI provider of its own. Unconfigured it fails closed (503) in prod, and falls back to a live-catalog stub in dev so `make dev` demos without a key. Description→item matching is deterministic client-side ([`lib/scan.ts`](lib/scan.ts)) — the model never emits SKUs |
| Artículos | [`components/items-screen.tsx`](components/items-screen.tsx) | Searchable catalog (iPad 2-col / phone 1-col, filter chips Todos/Crítico/Bajo/OK, live `<mark>` match-highlight, designed empty states) ⇄ item **detail/edit/create**. Detail: stat tiles + actions Marcar 86 (`toggle86`, immediate) / Reconteo / Merma (inline panels). Edit/create form: photo + name + category + **price + vendor** + unit + par. **Multi-select** (Seleccionar mode toggle, iOS Photos pattern — *not* always-on checkboxes) → floating bulk bar: batch Marcar 86 + Eliminar (confirm modal → N soft `archiveItem`s) with a 5s **Undo snackbar** that un-archives (`archiveItem(id,false)`); detail-view delete funnels into the same undo. Subsumes the former Add item / Edit item / 86 screens. Item sub-nav (`sel`) is lifted to the router so the top-bar back does detail → list. Also hosts **Escanear** ([`components/scan-register-flow.tsx`](components/scan-register-flow.tsx)) — floor **scan-to-register** (barcode-onboarding ADR D2, opened to the floor): camera-first scan → OFF public-API auto-fill → create + bind barcode (+ optional pack + receive-on-register), then the camera re-arms for the next package. Distinct from the search-bar camera (which *resolves* a known code to open its item) |
| Recibir | [`components/receive-flow.tsx`](components/receive-flow.tsx) | PO chips switch open orders in place → per-line OK / Falta (Falta reveals a received-qty input) → Confirmar recepción (`fetchPo` + `receivePo`) |
| Merma | [`components/waste-flow.tsx`](components/waste-flow.tsx) | Searchable item list → tap docks a bottom panel (qty stepper + reason chips + Registrar merma → `recordWaste`). The manager photo-evidence gate (`wasteSettings.photo_required_over_cents`) is preserved |
| Reconteo | [`components/recount-flow.tsx`](components/recount-flow.tsx) | Variance grid: every item shows Sistema:N + an actual-count input + variance badge (hidden on phone) → Guardar conteo (`applyCount`) |
| Success | [`components/flow-success.tsx`](components/flow-success.tsx) | Shared green-check confirmation for the three Movimientos flows. Merma + Reconteo also get an **Undo** button that reverses the stock change by re-applying the pre-write `on_hand` via `applyCount` (a fresh idempotency key — never the original) and returns home with a "Change undone" toast. Waste's reversal is an offsetting count (the append-only waste ledger row stays); recount's is a clean absolute restore. Recibir has no Undo |
| Shell | [`components/ipad-frame.tsx`](components/ipad-frame.tsx) | Demo iPad bezel for desktop preview; bypassed on real touch devices. Real-device path sizes to `100dvh` so each iPhone fills its actual viewport |
| Topbar | [`components/top-bar.tsx`](components/top-bar.tsx) | Employee pill + ES/EN toggle + auto-logout countdown + the single context-aware back chevron + a live **connectivity chip** (green Online / amber Offline, dot-only on phone) reflecting real `navigator.onLine` ([`lib/use-online.ts`](lib/use-online.ts)) |
| Router | [`components/crew-app.tsx`](components/crew-app.tsx) | Single-page state machine (`screen` ∈ home / scan / items / receive / waste / recount), lifted Items `sel` sub-nav, idle timer, home-screen polling, and a `backGuard` registry so a screen with unsaved state (scan review) can intercept the top-bar back chevron with a confirm dialog. Owns the **offline banner** (under the top bar; honest copy — saving still needs a connection, the durable write-queue is deferred) + an app-level **toast** (flow-undo confirmation, "Back online" on reconnect) |

## Responsive breakpoints

Defined in [`lib/use-crew-size.ts`](lib/use-crew-size.ts):

- `< 768px` → **phone**: stacked, single column, bottom safe-area padding, large tap targets
- `768 – 1180px` → **tablet** (portrait iPad): same as phone for most flows, full bleed
- `>= 1180px` + landscape → **desktop**: shown inside the iPad bezel for demos

The bezel is a preview affordance, not a product feature. Real iPad / phone always renders full-bleed.

## Commands

```bash
pnpm --filter @rop/crew-web dev          # http://localhost:3003
pnpm --filter @rop/crew-web build
pnpm --filter @rop/crew-web lint
pnpm --filter @rop/crew-web typecheck
pnpm --filter @rop/crew-web test:e2e     # Playwright PIN login suite (BFF mocked, no inventory-api needed)
```

Demo PINs:

- `123456` Maya Reyes (Prep Lead)
- `258025` Diego López (Line Cook)
- `777700` Samuel Kim (Line Cook)
- `432109` José Hernández (Dishwasher)

## Design philosophy (kept from the design handoff)

1. **Icon + color > text** — Mexican kitchen staff read images faster than English text.
2. **One screen, one task** — no "go back to peek and continue" cognitive context switch.
3. **Strong feedback** — every action ends in a big green ✓ + text confirmation.
4. **Reversible** — every step has an `Atrás` (back) button.
5. **Shortcuts replace input** — Mismo / Todo / quick number chips.
6. **Spanish default, English toggle that doesn't lose state**.

## Rules

- **Do not pull in heavy UI deps** (shadcn, framer-motion, react-query) without checking they're actually needed. The design is intentionally lean. If you find yourself needing them, the design is probably drifting. (The two deliberate runtime deps are `pdfjs-dist` — render a PDF invoice's first page to an image in the scan flow — and `barcode-detector` — decode a barcode from the camera in Artículos (ADR-0737): a ponyfill that uses the native `BarcodeDetector` on Chrome/Android and falls back to a zxing-wasm core on iOS Safari, which has no native `BarcodeDetector` (replaces the discontinued `@zxing/browser`). Both are **lazy-imported** ([`lib/pdf.ts`](lib/pdf.ts), [`components/barcode-scanner.tsx`](components/barcode-scanner.tsx)) so they stay out of the initial Floor bundle; pdfjs's worker is bundled same-origin for a hermetic build.)
- **Do not import `@rop/auth`.** crew-web treats the crew session token as opaque — it never signs or verifies it. The session HMAC secret lives only in `apps/inventory-api`; crew-web stores the token in an httpOnly cookie and forwards it. The cookie name is a local constant (`CREW_COOKIE`) in [`lib/server/inventory-api.ts`](lib/server/inventory-api.ts) — keep it in sync with `CREW_SESSION_COOKIE_NAME` (defined in `packages/auth/src/server/crew-pin.ts`, exported via `@rop/auth/crew`). Reads are open; writes carry the crew cookie and the API derives the actor (`who`) **and the actor's `locationId`** server-side from the session; inventory writes are scoped to that location (store-level tables carry `location_id`). crew-web stays location-agnostic — it forwards the opaque token, and the store is resolved server-side (multi-location, [docs/multi-location.md](../../docs/multi-location.md)).
- **Do not add desktop-only features** like sidebars or data tables. If managers need a feature here, they should do it in [`apps/backoffice-web`](../backoffice-web/) — that's the whole point of the Floor/Backoffice split.
- **The Artículos catalog now lets the floor set cost + vendor.** The design handoff folds the per-item editor into Artículos and adds *Precio unit.* + *Proveedor* to the edit/create form, relaxing the earlier "vendor/cost stay a backoffice job" stance. This is a deliberate product choice, not a boundary break: the inventory-api contract (`InventoryItemSave` / `InventoryItemCreate`) and the crew BFF always accepted these fields — only the old client shapes withheld them. Cost rides as `purchase_cost_cents` + `pack_qty` (the API derives `cost_cents`); see [`lib/api.ts`](lib/api.ts) `saveItemCost`. Deeper PO/vendor management stays a backoffice job. **Scan-to-register is likewise floor-available** (the owner opened it; supersedes ADR-0811 D2's backoffice-only stance) — no new auth was needed: inventory writes are dual-auth (the crew cookie is accepted) and the floor already authors items, so the `Escanear` flow only added OFF auto-fill + barcode binding, crossing no new trust boundary. All cooks can use it (no role primitive); the scan-register form deliberately omits vendor/price (editable later in the item detail).
- **Preserve the bilingual story**. Every new string must have both ES and EN entries in [`lib/strings.ts`](lib/strings.ts). The TypeScript `StringKey` union enforces this at compile time.

## Migration path

Per the [chat handoff](../../docs/), this Web app is **Phase 1** — a UX prototype to validate the flow with the actual line cooks before committing to a native iOS port (Phase 2). When the SwiftUI build starts, the JSX → SwiftUI translation should match screen-for-screen, reusing the same i18n strings and the same `inventory-data.js` fixture pattern.
