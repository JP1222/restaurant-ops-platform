# ADR-0019: Decouple store identity from Clover (POS-agnostic store model)

- **Status**: Accepted
- **Date**: 2026-05-28
- **Deciders**: @example-org
- **Supersedes**: part of [ADR-0018](./0018-multi-location-architecture.md) (the "keep `merchantId`, don't re-thread" scoping note — store identity is now conceptually `Location`, and Clover is one POS among possible others)

## Context

[ADR-0018](./0018-multi-location-architecture.md) introduced a POS-agnostic `Location` and assumed each location maps to a Clover merchant. The owner has since clarified the goal: **build the multi-location system now, before onboarding a second store, and the second store may run on a different POS (Square/Toast/etc.), not Clover.** The acceptance bar is explicit: *future onboarding of other stores must not cause big problems.*

Before deciding how far to decouple, we mapped the current coupling (kds-api + db-kds + analytics). The picture is more favorable than ADR-0018 implied:

**Already provider-neutral (the bones):**
- `OrderProvider` enum (`CLOVER | DELIVERECT | DEMO`) and a `provider` column on `CloverOrder` / `KdsTicket` — orders are already tagged by source.
- `KdsProviderConfig` is a per-`(merchantId, provider)` connection table (apiToken, hmacSecret, externalLocationId, providerLocationId, channelLinkId, environment, encrypted cipher columns) — the natural home for any POS's credentials.
- **`CloverMerchant` is already used as a generic store-identity table for a non-Clover source.** The Deliverect integration (`apps/kds-api/src/lib/deliverect-client.ts:240-257`) upserts a `CloverMerchant` row with a synthetic id (the Deliverect location id), `accessToken: "deliverect:webhook"`, `region: "DELIVERECT"`. Deliverect orders land in `CloverOrder` tagged `provider: DELIVERECT`.

**Where Clover is hard-wired (the couplings):**
1. **Naming**: `CloverMerchant` and `CloverOrder` are misnomers — they hold non-Clover stores/orders too.
2. **Store identity == `CloverMerchant.id`**: all **15** KDS business tables FK to `CloverMerchant` via `merchantId`.
3. **No clean non-Clover store-creation flow**: stores are minted via Clover OAuth, `CLOVER_MERCHANT_ID` env bootstrap, or the Deliverect webhook hand-crafting a row. No "add a store on POS X" admin path.
4. **Analytics is Clover-only**: `apps/analytics-api` hard-requires `CLOVER_MERCHANT_ID`/token; its raw schema is `raw.clover_*` with no `provider` dimension; ingestion is `CloverClient`. A non-Clover store's sales cannot enter the mart today.
5. **Ingestion adapters are POS-specific and irreducible**: orders/webhooks/menu sync for a new POS is new code that can only be written once the POS is chosen.

## Decision

**Option C: do not refactor the store model now.** The system already hosts a non-Clover data source (Deliverect) via a store-account row with a synthetic id + a `KdsProviderConfig` + provider-tagged orders — so onboarding a non-Clover store does **not** require re-threading the 15 FKs or migrating live KDS data. That migration is the only change that would be genuinely painful to do later, and the synthetic-store-account pattern avoids it entirely. This meets the "no big future problems" bar.

Onboarding a future non-Clover store (e.g. Square) is therefore **additive**: add the `OrderProvider` enum value, create the store-account row + `KdsProviderConfig`, and write the POS-specific ingestion adapter + analytics ingest path. The adapter is irreducible and POS-specific under every option, so paying for a rename or a `Location`-as-FK re-thread now buys nothing against the bar — and risks designing a generic abstraction for a POS whose data shape is unknown.

Two guardrails make deferral safe:
1. **Document the dual role now** — `CloverMerchant` and `CloverOrder` are the generic store-account / order tables (provider-tagged), not Clover-only. A schema comment + an AGENTS.md note record this so humans and AI agents don't assume Clover-exclusivity. (Cheap; near-zero risk.)
2. **Keep the remaining build provider-generic** — Phases 3-5 anchor on `Location` and iterate over generic stores + provider, never baking in a new Clover-only assumption. (Phase 4 inventory is already `locationId`-keyed.)

## Options considered

- **Option A — reframe now**: rename `CloverMerchant` → `StoreAccount`, move Clover credential columns into `KdsProviderConfig`, add a generic store-create flow. Medium churn; honest model now, but `merchantId` stays the key, so it doesn't avoid any future migration that C doesn't also avoid — it's earlier polish.
- **Option B — `Location` as FK target**: repoint all 15 FKs to `Location`, retire `merchantId`-as-store-key. Cleanest model, but the biggest, riskiest change (live-data migration) and speculative for a 2nd POS of unknown shape.
- **Option C — defer (chosen)**: keep the functionally-ready model, document the dual role, build provider-generic. Lowest churn; avoids the only painful migration; defers POS-specific work to when the POS is known.

## Deferred until the 2nd POS is chosen (with rationale)
- **Rename `CloverMerchant` → `StoreAccount`** — cosmetic; low-risk mechanical refactor at any time. Replaced for now by a dual-role doc comment.
- **`Location`-as-FK re-thread (Option B)** — not needed; the synthetic-store-account pattern decouples the store key from Clover-ness without it.
- **Analytics `provider` dimension + per-provider ingest** — POS-specific; must be designed against the chosen POS's reporting API.
- **The ingestion adapter** — irreducibly POS-specific; built when the POS is chosen.

## Consequences
- Store identity is conceptually `Location`; the POS is an attribute of a store's connection(s). This supersedes ADR-0018's "1 location = 1 Clover merchant" assumption.
- The misnomers (`CloverMerchant` / `CloverOrder`) remain, mitigated by the dual-role documentation. A future rename is unblocked and low-risk.
- A non-Clover store still requires a per-POS ingestion adapter + an analytics ingest path before it is live — by design, built when the POS is chosen.
