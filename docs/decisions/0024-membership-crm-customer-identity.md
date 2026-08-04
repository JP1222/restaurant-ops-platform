# ADR-0024: Membership / CRM — customer identity is one domain, owned by crm-api, keyed by phone

- **Status**: Proposed
- **Date**: 2026-05-30
- **Deciders**: @example-org
- **Related**: [ADR-0021](0021-loyalty-crm-domain.md) (db-crm + crm-api), [ADR-0022](0022-loyalty-ledger-and-accrual.md) (points ledger), [ADR-0018](0018-multi-location-architecture.md) / [ADR-0019](0019-decouple-store-identity-from-clover.md) (store identity), [ADR-0025](0025-online-ordering-architecture.md) (ordering)

## Context

Building loyalty surfaced a vocabulary/ownership question that, left unanswered, would fragment the suite: **is "membership" a separate system from "points," and where does customer identity live?**

Multiple surfaces want a "customer": `apps/order-web` captures a phone at checkout, `apps/marketing-site` has gift-card UI, loyalty needs a customer to attach points to, and future SMS campaigns need a contactable list. If each surface invents its own customer record, the same person becomes N disconnected rows — the online-order "Jane (901-…)", the in-store loyalty "Jane", and the gift-card "Jane" never unify. That defeats the entire reason for building our own CRM (a single cross-store, cross-channel customer view that no native-POS silo gives us).

The owner also clarified two scope points (2026-05-30): **no paid subscription tier** (the Panera-Sip-Club analog is declined), and membership should be the same thing as the loyalty/points enrollment, not a second system.

## Decision

**There is exactly one customer/membership domain, owned by `crm-api` (`packages/db-crm`).**

1. **Membership = an enrolled `CrmCustomer` + their `CrmLoyaltyAccount`.** "Points/rewards" are *features* on that membership ([ADR-0022](0022-loyalty-ledger-and-accrual.md)), not a separate system. There is no "membership system" distinct from the "points system" — they are one CRM domain. A "member" is a customer who has enrolled (given a phone + consent).

2. **`CrmCustomer`, keyed by `phoneE164`, is the SINGLE source of customer identity across the whole suite.** Every surface that needs "who is this customer" — `order-web`, `marketing-site`, loyalty, future campaigns — resolves/enrolls through `crm-api`. **No other app maintains its own customer table** (no customer rows in `db-kds`, `db-inventory`, or an `order-web` store beyond the in-flight cart). This is the load-bearing rule that keeps one person = one identity.

3. **Membership is free enrollment.** No paid subscription tier (declined 2026-05-30). No VIP/status tiers at launch ([ADR-0021](0021-loyalty-crm-domain.md)). "Member" means enrolled, full stop. If a tier or subscription is ever added, it is a new ADR and (for a subscription) a billing/stored-value review — it does **not** ride this one.

4. **A membership is brand-global, not per-store.** Identity is keyed by phone, spanning all of the owner's stores — consistent with multi-location ([ADR-0018](0018-multi-location-architecture.md)/[ADR-0019](0019-decouple-store-identity-from-clover.md)). Accrual/redemption ledger rows carry the **store identifier** (`merchantId` today, conceptually `Location` per ADR-0019) for attribution, but the **customer** is one identity across stores. crm-api keys by phone and reuses the suite's existing store identifier — it does **not** invent a parallel store key.

5. **Identity resolution lives only in crm-api.** E.164 normalization, dedup/merge, and recycled-/shared-number handling are a single chokepoint in crm-api. Surfaces send a raw phone; crm-api owns turning it into a stable `CrmCustomer`.

6. **Minimal PII + explicit consent.** db-crm stores only what the program needs: `phoneE164`, optional `email`, `birthMonth`, and `marketingSmsConsent`. TCPA/marketing consent is captured at enrollment. PII is **not** duplicated into other apps' databases — which also makes a CCPA/GDPR-style "delete me" a single-place operation.

## Consequences

- One customer = one identity across online ordering, in-store loyalty, and messaging. The cross-channel/cross-store view (the whole point of building CRM) is structurally guaranteed, not hoped for.
- Any surface needing customer data takes a runtime dependency on crm-api (an HTTP call to enroll/lookup). order-web/marketing must handle crm-api being unavailable gracefully (enrollment is best-effort; a failed loyalty lookup must never block placing an order — see [ADR-0025](0025-online-ordering-architecture.md)).
- "Membership" needs no new tables beyond db-crm's `CrmCustomer` + `CrmLoyaltyAccount` ([ADR-0021](0021-loyalty-crm-domain.md)) — this ADR is the *naming/ownership* decision, not new infrastructure.
- Deletion/export compliance is centralized in crm-api.

## Alternatives considered

- **Per-surface customer tables** (order-web stores its own customers, loyalty its own, etc.). Rejected: the same person fragments into disconnected rows; no unified view; the CRM's core value evaporates.
- **Customer identity in `db-kds`** (co-locate with orders). Rejected: crosses the domain boundary — kds-api is a POS-sync/KDS service, not a CRM; and it re-couples customer identity to the KDS database the loyalty build deliberately separated ([ADR-0021](0021-loyalty-crm-domain.md)).
- **Treat "membership" and "loyalty/points" as two systems.** Rejected as artificial: they operate on the same `CrmCustomer` + `CrmLoyaltyAccount` rows. Splitting the vocabulary invites someone to later build a parallel structure — the exact mess this ADR prevents.
- **Paid membership / subscription as the identity anchor** (Panera-Sip-Club style). Rejected for now (owner declined 2026-05-30); it is billing/stored-value-adjacent and would need its own ADR + legal review.

## Future work (out of scope here)

- Customer merge tooling (when two records turn out to be the same person) and recycled-number handling policy.
- A unified customer profile view in backoffice (reads crm-api over HTTP; never imports `db-crm`).
- If/when messaging campaigns ship, the consent/TCPA audit trail and unsubscribe handling.
