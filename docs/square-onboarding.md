# Square store onboarding — integration plan

> **Status:** current — plan for onboarding store #2 (Square POS). Scoped 2026-06-17 to **data-flow-first**: catalog import + orders→KDS + analytics ingest. Online ordering and card checkout are **explicitly deferred**. One Square location. No code has shipped yet; this is the build plan + the backoffice onboarding UI spec.

Related: [docs/multi-location.md](multi-location.md) (the `locationId`-vs-`merchantId` model), [docs/multi-provider-kds-roadmap.md](multi-provider-kds-roadmap.md) (the provider-adapter target architecture), [ADR-0018](decisions/0018-multi-location-architecture.md), [ADR-0019](decisions/0019-decouple-store-identity-from-clover.md), and [OPERATIONS.md](../OPERATIONS.md) §4.9 (onboard-a-second-store runbook).

## TL;DR

- Store #2's POS is **Square**, which is **one-merchant-many-locations** — the inverse of Clover's one-merchant-per-store. Every store, on either platform, is still one of our `Location`s; only the *credential* layer differs.
- **Decision (unified model):** a first-class **`PosAccount`** holds the credential (token), and each store is a **`PosStore`** binding (`providerStoreId` + a FK to its `PosAccount`) pointing at one `Location`. `PosAccount 1──N PosStore──1 Location`. **Clover is the fan-out-of-one special case** (account ≡ store); Square fans one account out to N stores. The per-store partition key (`PosStore.id`) is unchanged for Clover (= `merchant_id`) and `square:{location_id}` for Square, so the existing schema and store #1 are undisturbed.
- **Local verification is fully possible** in the Square **sandbox** with **no public endpoint and no tunnel**, by *polling* `SearchOrders` — which is exactly how our Clover loop already works locally (`dev:worker` reconciliation tick every 3s). Webhooks become a prod-only latency optimization; their signature check is unit-testable offline.
- **Priority order (per JP):** stand the store up on the existing POS-agnostic seams → connect + bind Square (with the backoffice add-store UI) → import catalog → orders→KDS via polling → analytics ingest. **Online ordering + checkout deferred.**

## 1. Architecture: one POS account binds to one or many stores

**Every store — Clover or Square — is one `Location`** (ADR-0018, `locationId` canonical). That layer is fully symmetric. The two platforms differ only at the *credential* layer, because their data models differ:

- **Clover** addresses data only by `merchant_id` (`/v3/merchants/{mId}/...`), one OAuth token per merchant. A Clover merchant *is* a store; a multi-location Clover business provisions multiple merchant accounts. So `merchant_id ≡ store` — that's why Clover looks "bound to a merchant": it's Clover's only store handle, not a constraint we impose.
- **Square** has one seller account (`merchant_id`) that natively owns **N `location_id`s** under one OAuth token; orders/payments are scoped by `location_id`, catalog is shared with per-location price overrides. So the credential lives one level *above* the store.

**The unified model (Clover is the fan-out-of-one special case):**

- **`PosAccount`** — a connected POS account = the credential. `(id, provider, providerMerchantId, accessToken, refreshToken?, tokenExpiresAt?, refreshTokenExpiresAt?, authStatus, environment)`. One row per connected account. **The token lives here, never on a store row.**
- **`PosStore`** — the per-store binding. `(id, posAccountId → PosAccount, provider, providerStoreId, locationId → Location)`. One row per store. `id` is the partition key the rest of the system already uses (KDS tickets, device tokens, `sync_targets`, reconciliation). Clover: `id = providerStoreId = providerMerchantId`. Square: `id = square:{location_id}`, `providerStoreId = location_id`.
- **`Location`** — our canonical store. Unchanged.

`PosAccount 1 ── N PosStore ── 1 Location`. **Clover = a `PosAccount` that fans out to exactly one `PosStore` (account ≡ store); Square = a `PosAccount` that fans out to N.** Same shape — the asymmetry collapses into "how many stores share one token," which is the platform's call, not ours. There is no "Square special case."

`PosStore` is the rename ADR-0019 deferred for the `CloverMerchant` table (now triggered, because a non-Clover store is landing). Do the table rename in its own migration; the credential split below is the functional change.

**Migration — store #1 (Clover) stays untouched:**
1. Add `PosAccount`; add a nullable `posAccountId` to the existing per-store table.
2. Backfill: for each existing Clover row, create one `PosAccount` (`provider = CLOVER`, `providerMerchantId = row.id`, copy its token) and point `posAccountId` at it. The row `id` is unchanged → every FK and partition key is intact.
3. Dual-read the token (legacy column + `PosAccount`) during the transition; drop the legacy token columns in a later migration (checkpoint per the migration rules).
4. Square onboarding writes one `PosAccount` (the seller) + one `PosStore` per active location.

> ⚠️ **VarChar(32) budget.** `PosStore.id` is `@db.VarChar(32)` (today's `CloverMerchant.id`) and every FK keys off it. `square:{13-char id}` ≈ 20 chars — fits, but Square location ids are not contractually length-capped: the minting code must guard it (reject/log if >32), and if there's any doubt widen the PK to `VarChar(64)` in the same migration (retrofitting a PK widening across all FKs later is far costlier). Analytics `sync_targets.merchant_id` is already `text`, so it has no cap.

This unified model (`PosAccount` + `PosStore`, Clover as fan-out-of-one) is recorded in [ADR-0795](decisions/0795-posaccount-posstore-unified-store-identity-model.md).

## 2. Local verification: yes, sandbox + polling, no tunnel

**Verified against current Square docs (2026):**

- Sandbox host `https://connect.squareupsandbox.com`; sandbox access token + Application ID on the app's Credentials page; up to 10 sandbox test sellers. Sandbox has **one mock location per app** — perfect for the single-location case.
- **Catalog:** seed via `BatchUpsertCatalogObjects` (≤10k objects, ≤1k/batch), read via `SearchCatalogObjects` / `ListCatalog`. Only one catalog write is processed per seller at a time (concurrent writes → 429), so **seed serially**.
- **Orders:** `CreateOrder` (with `PICKUP` fulfillments) + `SearchOrders` work in sandbox. For incremental polling, filter on `updated_at` **and** sort on `UPDATED_AT` (Square requires the sort field to match the filtered field).
- **No public endpoint needed for the data flow.** The order→KDS loop is verifiable locally purely by **polling** `SearchOrders` — mirroring the existing Clover reconciliation. There is no "POS terminal simulator"; you generate test orders with `CreateOrder`.
- **Webhooks are optional** and the only piece that needs a public HTTPS URL (tunnel / `webhook.site`) for *real* delivery. Their signature check (HMAC-SHA256 over `notificationUrl + raw body`, key = per-subscription `signatureKey`) is **unit-testable offline** via the SDK's `WebhooksHelper.verifySignature`. Treat the dashboard "Send test event" as unverified for signature exercise — cover it with offline unit tests instead.

**SDK:** npm package is **`square`** (v40+ rewrite). `new SquareClient({ token, environment: SquareEnvironment.Sandbox })`; namespaced clients (`client.catalog.batchUpsert`, `client.orders.create/search`, `client.locations.list`, `client.webhooks.subscriptions`). **`Money.amount` is `bigint`** (the #1 migration footgun; `JSON.stringify` throws on bigint — coerce at the contract boundary).

**Dev strategy:** put a Square *sandbox* token in Infisical `dev` (mirroring the Clover sandbox pattern), point the Square client at the sandbox host in local config, and the existing 3s reconciliation tick pulls sandbox orders into the local KDS — full catalog→order→KDS→analytics loop, offline.

## 3. Scope

**In scope (the data flow):**

| Capability | Why it's in |
| --- | --- |
| Provider plumbing (enum, `PosAccount` + `PosStore`) | Foundation for everything |
| Square connect + ListLocations + bind (backoffice UI) | The onboarding flow JP is prioritizing |
| Catalog / menu import | "Import data" |
| Orders → KDS via polling | The runtime data flow ("把数据流打通") |
| Analytics ingest | Sales land in the mart for dashboards |

**Deferred (not now):**

| Capability | Why deferred |
| --- | --- |
| Online ordering (order-web wiring) | JP: 在线单点可以延后 |
| Card checkout / payment runtime | JP: 结账也可以先延后 — the whole Web Payments + per-store fail-closed money path |
| Multi-location-per-merchant exercise | Only one Square location for now (design stays forward-compatible) |

## 4. Phased plan (data-flow-first ordering)

**Phase 0 — Provider plumbing + stand the store up on placeholders.**
- Add `square` to the contracts `orderProviders` tuple **and** the Prisma `enum OrderProvider` (an `ALTER TYPE "OrderProvider" ADD VALUE 'SQUARE'` migration — irreversible, can't run in a txn on older PG; define a checkpoint/rollback note per the migration rules), plus the lowercase↔UPPERCASE provider mapper branch.
- Add the `PosAccount` table + `posAccountId` FK; backfill one `PosAccount` per existing Clover row (store #1 undisturbed, §1 migration). `PosStore` is the existing per-store table (rename from `CloverMerchant` in its own migration).
- Hand-seed a Location + a `PosStore` row (with a placeholder `PosAccount`); pair a KDS device, give crew a `locationId`, confirm inventory/crew/KDS isolation from store #1.
- ✅ Write the ADR for §1 (the `PosAccount`/`PosStore` model) — [ADR-0795](decisions/0795-posaccount-posstore-unified-store-identity-model.md).
- **Ships:** store #2 runs KDS + inventory + crew with seeded rows. No menu/orders/analytics yet.

**Phase 1 — Connect Square + ListLocations + bind (the onboarding UI; the dependency gate).**
- Backend: `bootstrapSquareAccountFromEnv()` (local/dev, mirrors `bootstrapMerchantFromEnv` for Clover) for the sandbox token path; `POST /api/square/connect` (validate token → `ListLocations` → upsert one `PosAccount` + one `PosStore` per active location). OAuth (`/api/square/install` + `/oauth/callback`) is the production path; for a single owned account a Personal Access Token is the simpler day-1 option (see open questions).
- The existing `bind` route (ADR-0019 / PR #713) is already POS-agnostic — reuse it to bind each `PosStore` to a `Location`.
- Token refresh cron only if OAuth is chosen (≤7d before the ~30d expiry; code-flow refresh token is multi-use, PKCE rotates single-use/90d — persist the new one atomically on the `PosAccount`).
- App PAT (for webhook config, later) is app-level — kept **separate** from the per-seller `PosAccount.accessToken`.
- **Ships:** operator connects Square once in backoffice, sees the location, binds it. The `PosAccount` + `PosStore` are now real.

**Phase 2 — Catalog / menu import.** *(menu half SHIPPED — PR #754 + the menu-wiring PR; recipe half is the remaining follow-up.)*
- ✅ `square` SDK catalog client (`fetchCatalog`) + `normalize-square-catalog` → the same POS-neutral `OrderMenuResponse`. Price lives on `ITEM_VARIATION` (single-price item → one "Regular" variation); `VARIABLE_PRICING` priced 0; modifier lists flat (join by id); category from `reportingCategory`; per-location price from `locationOverrides` filtered to the bound location. `Money.amount` bigint→cents coerced at the normalize boundary (no bigint escapes `JSON.stringify`); `Square-Version` pinned in the client.
- ✅ Provider-aware menu read (`resolveOrderStore`/`loadMenu`, §5) + `POST /api/square/import-catalog` → `CatalogImportResult` (the wizard step-4 import; counts only — ADR-0027 menu = live POS, nothing persisted).
- ⏳ **Remaining:** inventory recipe sync keyed by Square `CatalogObject.id` (add `square_catalog_item_id` alongside `cloverItemId` in `inventory_recipes`, in `inventory-api`) so recipes are available for depletion.
- **Ships:** Square menu renders read-only (live); operator sees imported counts. Recipe-depletion wiring follows.

**Phase 3 — Orders → KDS (polling).** *(SHIPPED — PR #764 + the reconcile-wiring PR.)*
- ✅ `normalize-square-order` → `NormalizedOrder(provider:'square')` (reuses `buildStableItemKey`; bigint money + string quantity coerced; pickup recipient → loyalty customer). The reconciliation poll ([reconciliation.ts](../apps/kds-api/src/jobs/reconciliation.ts)) now reads each `clover_merchants` row's `posAccount.provider` and routes a Square store to `SearchOrders` (filter+sort on `updated_at`) instead of Clover's `fetchModifiedOrders` — the critical fix, since a `square:{loc}` row would otherwise be Clover-polled and 502. The rest (`syncNormalizedOrder`) was already provider-agnostic.
- ✅ Ticket creation gated on payment: `paymentState = "PAID"` iff `net_amount_due_money == 0` (or a `COMPLETED` order); `shouldSkipForUnpaidState` keeps an UNPAID Square order off the board (fail closed).
- ✅ The hardcoded provider dispatch in `queue/handlers.ts` is now a `switch` (DELIVERECT / SQUARE / default-Clover) — `syncSquareOrderById` re-fetches the order fresh (`fetchOrder`) and syncs it.
- ⏳ **Deferred (prod-latency niceties, not blocking the data flow):** the **scheduled-pickup** gate (`schedule_type==ASAP OR now >= pickup_at - prep_time`) so paid order-aheads don't plate early; **Square fulfillment write-back** (KDS status → Square, the `processFulfillmentJob` Square branch); and the **webhook route** (raw-body HMAC via `WebhooksHelper.verifySignature`, route-scoped raw parser, fail closed — **do not** template off the shared-secret Clover webhook; the one HMAC attempt #119 was reverted).
- **Ships:** Square orders flow to the kitchen via polling, verified locally against the sandbox by `CreateOrder` + the 3s reconcile tick (no tunnel).

**Phase 4 — Analytics ingest.** *(SHIPPED — Lean scope: orders + line items + payments/tenders + refunds; no employees; forward-only, no historical backfill. PRs #775/#780/#785/#789/#790 + the token push.)*
- ✅ Square ingest adapter (`SearchOrders`/`listPayments`/`listRefunds`, the analytics `SquareClient` wrapping the SDK — bigint money coerced to number at the boundary since payloads persist as `jsonb`) → `raw.square_*` tables (#775 schema, #780 client, #785 sweep job). The scheduler branches on `sync_targets.provider`: a Square target enqueues only the `square_sweep` (no Clover bulk-export `export_reconcile`/`historical_export_backfill`, and **no `external_recon`** — so the Square-payment-retention concern below is N/A for the Lean scope). Keyed by the synthetic `square:{location_id}`.
- ✅ Provider-aware raw→mart transform (#789): `normalize-square.ts` produces the same `Normalized*` shapes Clover does, so the mart fact/dim/MV schema is **unchanged**. `mart-loader.refreshMartForRange` dispatches the source table + normalizer on `provider`, and **fails loud on an unknown provider before the destructive `deleteMartRange`** (a misdispatch would otherwise wipe the merchant's mart range with no source). `store_timezone` comes from the Square `ListLocations` per-location tz (pushed into `sync_targets`).
- ✅ Sold-items feed carries `square_catalog_item_id` (#790) — `fact_order_line_items.item_id` already holds the Square `catalog_object_id` (from the transform), so the feed routes it to the right contract field by provider. Unblocks the gated Phase-2 recipe-sync half.
- ✅ The kds-api→analytics **token push** (the deferred multi-location "P3"): after `/api/square/connect` persists, kds-api POSTs `{merchant_id, provider:'square', token, store_timezone, active}` to the existing `POST /admin/api/sync-targets`, gated by a **dedicated `KDS_ANALYTICS_PUSH_TOKEN`** bearer (narrower than `ANALYTICS_ADMIN_TOKEN` — kds-api can register a sync target and nothing else; analytics never calls back). Best-effort + non-fatal to the connect; **never logs the token** (tokenLast4 only). Secret provisioned in Infisical `dev`+`prod` root. URL = the existing `INTERNAL_ANALYTICS_API_URL`.
- **Future (mixed-fleet, deferred):** the payment-retention age bound (`CLOVER_PAYMENTS_RETENTION_DAYS`) only matters once Square runs `external_recon` — out of Lean scope. When Square gets external recon, move that bound to a per-`sync_targets` column (Clover unbounded, Square's real horizon), or an aged-out day's false-zero re-fetch would drop a real data-loss alarm. See `external-recon.ts` `classifyRecon`.
- **Ships:** per-store analytics include the Square store with correct timezone + money math — live the moment a `provider='square'` sync target is registered (the connect push, or a manual `POST /admin/api/sync-targets`).

**Deferred — Online ordering + checkout.** When JP wants it: order-web reads the store from URL/QR and forwards `?location=`; a `SquarePaymentsClient` (Web Payments SDK tokenize → `CreateOrder` + `CreatePayment` with an **explicit, server-resolved** `location_id`); and the PR #723 fail-closed gate is re-implemented as a **provider-dispatched** chokepoint (see §6).

## 5. Where Square plugs into the code

The local-dev order→KDS path is **polling-based**, not webhook-dependent. The seams (all in `apps/kds-api`):

| Seam | File | What to add |
| --- | --- | --- |
| Provider client | `src/lib/services.ts` | `const square = new SquareClient(...)` alongside `clover` / `deliverect` |
| Reconciliation poll | `src/jobs/reconciliation.ts` | a `provider === "SQUARE"` branch → `SearchOrders(updated_at)` → enqueue `SyncOrderJob{provider:"SQUARE"}` |
| Fetch + normalize | `src/lib/sync-order.ts`, `src/domain/normalize-order.ts` | `services.square.fetchOrder` + `normalizeSquareOrder` → `NormalizedOrder` (the rest is provider-agnostic) |
| Env bootstrap (dev/sandbox) | `src/lib/clover-client.ts` (`bootstrapMerchantFromEnv`) as the template | `bootstrapSquareAccountFromEnv()` upserts the `PosAccount` + `PosStore` rows |
| Config | `src/config.ts` | `squareApiBaseUrl` (sandbox switch), `squareAccessToken`, `squareEnvironment`, etc. |
| Menu | `src/routes/order.ts` (`loadMenu`) | branch on provider so a `square:` id never calls `services.clover.fetchMenuItems` (would 502) |
| Webhook (optional) | new `src/routes/square.ts`, template-of-shape only from `src/routes/clover.ts` | raw-body HMAC verify; same `createProviderEvents` queue |
| Analytics | `apps/analytics-api/src/scheduler/` + a Square adapter | provider-aware ingest + transform, dispatched by `sync_targets.provider` |

> ✅ **Done (Phase 2 menu-wiring PR).** `resolveOrderStore` ([order-store.ts](../apps/kds-api/src/lib/order-store.ts)) now returns `provider` (read off the bound `PosStore`'s `PosAccount`), and `loadMenu` ([order.ts](../apps/kds-api/src/routes/order.ts)) branches on it — a Square store reads its Square catalog via [square-menu.ts](../apps/kds-api/src/lib/square-menu.ts) instead of 502-ing on Clover. The **draft / checkout** path stays Clover-only: a Square store is refused there with a clear 503 ("online ordering isn't available for this store yet"), since checkout is deferred (§6).

## 6. Payment safety (forward-looking — checkout is deferred, but the design must stay fail-closed)

Even though checkout is deferred, two things must be true the moment any money path is built:

1. **Square's `location_id` is fail-OPEN by default** — `CreatePayment`/`CreateOrder` silently charge the merchant's **main** location when `location_id` is omitted. Every money call must pass an **explicitly server-resolved** `squareLocationId` (from the bound store row, never client input), **fail closed** if the store has no bound location, and validate it against `ListLocations` before charging.
2. **The current #723 gate stays correct meanwhile.** Today's gate is `draft.merchantId !== configuredMerchantId → 503`; a `square:` id can never equal the configured Clover merchant, so it **already refuses every Square order** (safe). When checkout is built, re-implement the gate as a **provider-dispatched** chokepoint (Clover → compare to configured merchant; Square → resolve+validate location, refuse if absent), **not** a replacement of that branch — and gate the work on a wrong-store/fail-closed test matrix. Also: `OrderDraft` must carry a `provider` field, or a Square draft falls into the Clover charge path (fail-WRONG). Distinct idempotency keys per operation (`pay:{draftId}` / `refund:{draftId}`, ≤45 chars).

## 7. Security & secrets

- The Square access token is a secret: stored server-side (Infisical `dev` for sandbox, `prod` for production — mirror the Clover split), **write-only** in the UI (never render it back — show "configured ✓ / ••••last4"), and **never logged**.
- **At-rest encryption — DONE (cipher-only).** Migrations `20260617_pos_token_cipher` + `20260618_pos_token_refresh_recovery_cipher` added `*Cipher Bytes?` columns to both `pos_accounts` (access + refresh) and `clover_merchants` (access + refresh + recovery). Every OAuth secret is AES-256-GCM encrypted on write (`encryptSecretForStorage` in `apps/kds-api/src/lib/pos-token.ts`, reusing the Deliverect `AI_TOKEN_ENCRYPTION_KEY` primitives) and read **cipher-only** via `resolveCloverMerchantSecrets` / `resolvePosAccountSecrets`; the Clover token on its own row is covered the same way. The one-off backfill ran on prod (`remaining plaintext: 0`), then migration `20260618_drop_pos_token_plaintext` dropped the legacy plaintext `accessToken`/`refreshToken`/`recoveryToken` columns and the resolvers + callers were simplified to cipher-only, retiring the dual-read window (mirrors the Deliverect Phase 4.5.7 plan). The spent backfill script was removed once its job was done.
- Sandbox and production are fully separate hosts / credentials / catalogs / webhook subscriptions / signature keys.
- The kds-api→analytics token push (Phase 4) moves a token across a service boundary — never log it; source the store timezone from `Location.timezone` to keep the two TZ sources in sync.

## 8. Adversarial-review traps (must-handle during implementation)

These were caught reviewing against the actual code and are easy to get wrong:

1. **Two provider enums** — the lowercase contracts tuple *and* the UPPERCASE Prisma `enum OrderProvider`. Adding Square needs both + the mapper branch + a migration. (Phase 0 is a schema phase, not a placeholder phase.)
2. **The credential split must be backward-compatible** — moving the token off the per-store row onto `PosAccount` touches the working Clover path (`bootstrapMerchantFromEnv` writes the token; reconciliation reads it). Backfill + dual-read during the transition, drop legacy columns in a later checkpointed migration; never destabilize store #1 to land store #2 (§1 migration).
3. **VarChar(32) PK budget** on `PosStore.id` (= `square:{location_id}` for Square) — document + guard (§1).
4. **`resolveOrderStore` / `loadMenu` are Clover-shaped** — branch on provider or a Square store 502s (§5).
5. **Webhook HMAC is greenfield** — no working precedent in the repo; don't copy the reverted #119 (§4 Phase 3).
6. **Single app-level webhook subscription** receives events for all sellers — resolve the event's `merchant_id`/`location_id` → `PosStore` and ack-and-drop unknown ones (when webhooks land).
7. **`Money.amount` bigint / `quantity` string** — coerce in `packages/contracts` or every serialization boundary is a latent crash.

## 9. Backoffice onboarding UI spec (for Claude Design)

Backoffice-web is Next.js 16 + Tailwind v4 + **shadcn/ui** (see `apps/backoffice-web/AGENTS.md` — don't introduce a second component library). The store switcher already exists in the header (left of the avatar). The new work is the **add-store wizard** + a per-store **POS connection** management view.

### Pages

| # | Page / route | Purpose |
| --- | --- | --- |
| 1 | **Store switcher menu** (existing header dropdown, left of avatar) | Add a `+ Add store` action at the bottom of the store list |
| 2 | **Add-store wizard** (`/settings/stores/new`, or a modal) | The guided flow: basics → platform → credentials → import → done |
| 3 | **Stores list** (`/settings/stores`) | Table of stores: name, platform, location, connection status, actions |
| 4 | **Store settings / POS connection** (`/settings/stores/[id]`) | View/manage the binding: connection status, re-import catalog, rotate token, environment, remove store |

### Wizard steps (page 2)

1. **Store basics** — `name` (required); `timezone`, `address` (optional — timezone can auto-fill from the platform later). Creates the `Location`.
2. **Choose platform** — selectable cards: **Clover**, **Square**. (Leave room for "more coming".)
3. **Connect credentials** (provider-specific):
   - **Square:** an **Environment** toggle (Sandbox / Production — important for dev), a masked **access token** input (write-only, show/hide, paste), a **Test connection** button (calls `ListLocations`), then a **location select** (auto-selected when there's one). "Connect with Square" (OAuth) can be offered as an alternative/future method.
   - **Clover:** the existing OAuth "Connect" button (PR #713).
   - Mark required vs optional fields clearly.
4. **Import data** — a **catalog import** card (button → progress → "imported N items, M modifiers"); optional **historical sales import** (date range) for analytics backfill.
5. **Done / summary** — a capability checklist: ✓ KDS, ✓ inventory, ✓ crew, ✓ menu, ✓ analytics; 🔒 online ordering / checkout (coming later).

### Components

| Component | Built on | Notes |
| --- | --- | --- |
| `StoreSwitcherMenu` (extend existing) | shadcn `DropdownMenu` | add the `+ Add store` item |
| `AddStoreWizard` + `WizardStepper` | shadcn `Dialog`/route + a stepper | container + step state |
| `StoreBasicsForm` | `Input`, `Label`, `Select` (timezone) | name required; rest optional |
| `PlatformPicker` | `RadioGroup` of `Card`s | Clover / Square, with logos |
| `SquareCredentialForm` | composed | see sub-components below |
| → `EnvironmentToggle` | shadcn `Tabs`/segmented | Sandbox / Production |
| → `SecretInput` | `Input` (type=password) + show/hide | masked, write-only token |
| → `TestConnectionButton` + `ConnectionResult` | `Button` + `Alert` | shows merchant + locations on success |
| → `LocationSelect` | `RadioGroup`/`Select` | from `ListLocations`; auto-select single |
| `CloverCredentialForm` | reuse existing "Connect POS" | OAuth button |
| `ConnectionStatusBadge` | shadcn `Badge` | connected / not connected / token expiring / error |
| `CatalogImportCard` | `Card` + `Progress` + `Button` | item/modifier counts, progress, result |
| `HistoricalImportCard` (optional) | `Card` + date range picker | analytics backfill |
| `CapabilityChecklist` | list with check/lock icons | what's enabled vs deferred |
| `StoresTable` | shadcn `Table` | page 3 |

### Data the UI needs (so the design matches the contracts)

- `Store`/`Location`: `id`, `name`, `timezone`, `platform` (`clover`|`square`), `connectionStatus`, `locationLabel`.
- `TestConnectionResult`: `{ merchantName, locations: [{ id, name, timezone, currency }] }`.
- `CatalogImportResult`: `{ itemCount, modifierCount, categoryCount, durationMs }`.
- Security: the token field is **write-only** — the API never returns it; status comes back as `configured: true` + `last4`.

## 10. Open questions

**Resolved (this session):** local sandbox verification is possible by polling (§2); one location; online ordering + checkout deferred; the identity-model mapping (§1).

**Remaining (confirm tomorrow with Square account access):**

1. **OAuth vs Personal Access Token?** For a single owned account a PAT is the simpler day-1 path (long-lived, no refresh plumbing); OAuth matches the multi-location direction. If OAuth: code flow (multi-use refresh token) vs PKCE (single-use rotating, 90d).
2. **Is there a Developer Console app** (Application ID + sandbox/prod credentials)? If not, create it first.
3. **Sandbox creds into Infisical `dev`** so the local loop can be verified before prod.
4. **Should the Square catalog be the source of truth** for that store's menu (analogous to Clover for store #1)?
