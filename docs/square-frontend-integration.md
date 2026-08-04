# Square onboarding — frontend ↔ backend integration

> **Status:** current — the wiring contract between the **design handoff** (the `Stores & POS.dc.html` prototype + its `README.md`) and the **shipped backend**. Read the design README for look/behaviour (it's the visual spec); read this for *what to call, the exact shapes, and the four places the design and backend must be reconciled*. Backend is merged: see [docs/square-onboarding.md](square-onboarding.md) and PRs #739/#744/#747/#748.

Target app: **`apps/backoffice-web`** (Next.js 16 · Tailwind v4 · shadcn/ui · light + dark). Out of scope: online ordering, cart, checkout/payment.

## TL;DR — what's already built vs. what you build

- **Backend (done, on `main`):** kds-api `POST /api/square/test-connection` + `POST /api/square/connect`; the `Square*` zod contracts in `@rop/contracts`; the store CRUD + bind BFF routes in `apps/backoffice-web/app/api/locations/*` (create #706, bind/unlinked-merchants #713).
- **You build:** the four UI surfaces from the design README, **three backoffice BFF proxy routes** for Square (below), and the wizard's state machine. Catalog import (step 4) **now has a real backend** (`POST /api/square/import-catalog`, PR #754 + the menu-wiring PR) returning `CatalogImportResult` — wire it for real; you only need the mock as a loading-state fallback.

## 1. Endpoints

### Already in the backoffice BFF (reuse — don't rebuild)
- `GET /api/locations` — list stores · `POST /api/locations` — create a store (wizard step 1).
- `GET /api/locations/[id]` — store detail · `GET /api/locations/unlinked-merchants` — connected store-accounts with no Location yet.
- The **bind** route (#713) under `app/api/locations/*` — binds a store-account (`PosStore`) to a `Location`. Find it and reuse it for the wizard's final bind (§3.3).

These BFF routes already proxy to the kds-api admin surface with the internal bearer — **mirror that exact pattern** for the two new Square routes below (the browser never holds the kds-api admin token).

### New backoffice BFF routes you add (thin proxies to kds-api)
| BFF route (you add) | proxies to (kds-api, exists) | body | returns |
|---|---|---|---|
| `POST /api/square/test-connection` | `POST /api/square/test-connection` | `SquareConnectRequest` | `SquareTestConnectionResponse` |
| `POST /api/square/connect` | `POST /api/square/connect` | `SquareConnectRequest` | `SquareConnectResponse` |
| `POST /api/square/import-catalog` | `POST /api/square/import-catalog` | `SquareImportCatalogRequest` (`{posStoreId}`) | `CatalogImportResult` |

All three kds-api routes are ADMIN-bearer (`createAdminBearerGuard`) — the BFF attaches the internal admin token, same as the existing `app/api/locations/*` handlers.

## 2. Contracts — import them, don't re-hand-roll (Iron Law #2)

All shapes live in `@rop/contracts` (`packages/contracts/src/square.ts`). Import these; do **not** write parallel TS types:

```ts
import {
  SquareConnectRequestSchema,        // { accessToken: string; environment: 'sandbox'|'production' }
  SquareTestConnectionResponseSchema,// { merchantId, merchantName, environment, locations: SquareLocationSummary[] }
  SquareConnectResponseSchema,       // { posAccountId, merchantId, merchantName, environment, tokenLast4, stores: SquareConnectStore[] }
  SquareEnvironmentSchema,           // 'sandbox' | 'production'
  type SquareLocationSummary,        // { id, name, timezone, currency }
  type SquareConnectStore            // { posStoreId, providerStoreId, name, timezone, currency, locationId }
} from "@rop/contracts";
```

The design README's `TestConnectionResult { merchantName, locations[{id,name,timezone,currency}] }` is a subset of `SquareTestConnectionResponse` — the location shape matches **exactly** (`SquareLocationSummary`). Use the contract type.

## 3. The four reconciliation points (design ⟷ backend)

### 3.1 Error taxonomy — map the design's 3 errors onto the backend's real kinds
The connect/test-connection routes return these on failure (the **kind** is in the JSON `error` field; HTTP status in parens):

| Backend `error` kind | HTTP | Design treatment |
|---|---|---|
| `invalid_token` | 400 | The design's **"Invalid token"** alert. **Also surface the design's "Wrong environment" affordance here** — see note. |
| `insufficient_scope` | 400 | Token lacks `MERCHANT_PROFILE_READ`. Show as a token/permission error ("this token can't read the merchant profile"). *(Design has no variant for this — add one, or fold into the invalid-token alert with this message.)* |
| `timeout` | 504 | The design's **"Couldn't reach Square"** alert. |
| `no_locations` | 422 | Valid token, zero active locations. Reuse an "empty" style: "No active locations in this Square account." *(Design has no variant — add a short one.)* |
| `upstream` | 502 | Generic "Square returned an unexpected error — try again." |
| `invalid_body` | 400 | Client-side validation should prevent this; treat as a generic error. |

> **Critical note on "Wrong environment".** The design treats wrong-environment as a *distinct* error with a `Switch to {otherEnv}` action — that's great UX, **but the backend cannot detect it**: a sandbox token used against production (or vice-versa) returns Square 401, which the backend maps to **`invalid_token`** (indistinguishable from a bad token). So implement "wrong environment" as an **affordance layered on `invalid_token`**, not a separate API outcome: on `invalid_token`, show "Invalid token — or it may be for the wrong environment" with the `Switch to {otherEnv} and retry` button. Do **not** build a branch that waits for a "wrong_environment" kind from the API — it never comes.

### 3.2 PAT, not OAuth → no auto-expiry
We use a **Personal Access Token** (decided: it's a single owned account, not multi-tenant). PATs are long-lived and carry **no expiry we track**. So:
- The detail page's **"Rotate token"** (manual) stays — useful.
- The **"Token expiring in N days" auto-banner** and the **`expiring` status badge** have **no data source** — don't wire them to a non-existent expiry field. Keep the badge component (4 states) but `expiring` simply won't occur for Square PAT; `connected` / `none` / `error` are what you'll see.

### 3.3 Multi-location → the bind step (the README omits this)
`POST /api/square/connect` creates **one `PosAccount` + one `PosStore` per active location** and returns them in `stores[]`. The wizard's "Select a location" picks **one** for *this* store. So on **Finish**:
1. (step 1 already) `POST /api/locations` → the new `Location` (id `L`).
2. (step 3) `POST /api/square/connect` → returns `stores[]`, each with a `posStoreId`.
3. (on Finish) **bind the selected location's `posStoreId` to `L`** via the existing bind route (#713). The other `stores[]` rows stay unbound (available for additional stores).

The design README does not mention step 3's bind call — wire it. `posStoreId` (e.g. `square:LV78H3YNW202D`) is the value the bind route takes as its store-account id.

### 3.4 Catalog import (step 4) = built — wire it for real
The design's import card (idle/running/success/empty/error) now has a backend: `POST /api/square/import-catalog` with body `{ posStoreId }` returns `CatalogImportResult { itemCount, modifierCount, categoryCount, durationMs }`. It reads the bound store's **live** Square catalog and returns counts (ADR-0027: menu = POS inventory — nothing is persisted; the menu is served live by `/api/order/menu`, which is now Square-aware). Call it with the `posStoreId` from the connect step's `stores[]` (the same id you bind in §3.3). Error mapping: `404 not_found` (store missing), `409 not_square` (store isn't Square), and the §3.1 upstream kinds (`invalid_token` 400 / `timeout` 504 / `upstream` 502) if Square fails mid-fetch. The optional **historical-sales import** is still backend-pending — keep that one mocked.

## 4. State → API map (the README's wizard state ⟷ real calls)
- `token` — write-only; **never hydrate from the server**. Lives only in component state until submitted.
- `testState`/`testResult` ← `POST /api/square/test-connection`.
- Finish (Square) → `POST /api/square/connect` → then bind the selected `posStoreId` (§3.3).
- `importState` ← Phase 2 (mock).
- Clover branch → reuse the existing Clover OAuth connect (no new backend).

## 5. Security (must honor — matches the design README "Security UX")
- **Token is write-only.** Responses never carry it — only `tokenLast4`. Never render a full token; show `•••• 4f2a` + `Configured ✓`.
- **Environment is identity.** Always surface which environment a test/connection used (the success alert's env badge). This is the highest-leverage guard against the wrong-env mistake.
- The kds-api admin bearer lives **only** in the BFF, never the browser.

## 6. Conventions
- shadcn/ui only (no second component library — see `apps/backoffice-web/AGENTS.md`). lucide-react for icons. Tailwind v4 semantic tokens from `app/globals.css` (don't hardcode the prototype hexes).
- Verify build + lint + unit + e2e (the wizard flow) in **both** light and dark before done. Don't deploy (user-gated).
- Sandbox note: the real sandbox seller returns one location, timezone `UTC` (the prototype mock shows `America/Chicago` — real data populates correctly).
