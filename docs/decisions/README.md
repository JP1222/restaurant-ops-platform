# Architecture Decision Records (ADRs)

This folder captures the *why* behind load-bearing architectural choices in Example Kitchen. Each ADR records one specific decision: what problem prompted it, what was chosen, what the consequences are, and what alternatives were considered.

ADRs are **English-only by convention** — the audience is engineers, the format is dense, and translation churn outweighs the benefit. The user-facing top-level [`ARCHITECTURE.md`](../../ARCHITECTURE.md) is bilingual.

## Index

| ADR | Title | Status |
|---|---|---|
| [0001](0001-pnpm-monorepo-with-four-apps.md) | pnpm monorepo with four apps | Accepted |
| [0002](0002-five-iron-laws.md) | Five Iron Laws as boundary enforcement | Accepted |
| [0003](0003-floor-vs-backoffice-split.md) | Floor (kds-web) vs Backoffice (backoffice-web) split | Accepted |
| [0004](0004-static-clover-token-from-db.md) | Static Clover token from DB, OAuth optional | Accepted — single-merchant premise amended by [0018](0018-multi-location-architecture.md) |
| [0005](0005-dokploy-over-coolify.md) | Dokploy v0.29 chosen over Coolify v4 | Accepted |
| [0006](0006-self-hosted-arm64-runner.md) | Self-hosted arm64 GHA runner on Oracle | Superseded by [0008](0008-cutover-arm64-runner-to-mac-mini.md) |
| [0007](0007-validate-compose-env-script.md) | `validate-compose-env.py` guardrail against env drift | Accepted |
| [0008](0008-cutover-arm64-runner-to-mac-mini.md) | Cutover arm64 GHA runner from Oracle to Mac Mini | Accepted |
| [0009](0009-pipeline-optimization-followups.md) | Pipeline optimization follow-ups | Proposed |
| [0010](0010-heartbeat-on-mac-mini.md) | Heartbeat monitoring on Mac Mini | Accepted |
| [0011](0011-ai-tables-bounded-exception.md) | AI assistant tables are a bounded exception to the DB boundary | Accepted |
| [0012](0012-architecture-as-guardrails.md) | Architecture as guardrails — the AI-agent contract | Accepted |
| [0013](0013-lan-fallback-roadmap.md) | Realtime assumes cloud reachability — LAN fallback is roadmap | Proposed |
| [0014](0014-manual-deploy-trigger.md) | Manual deploy trigger (merge ≠ deploy) | Accepted |
| [0014](0014-sentry-saas-over-glitchtip.md) | Sentry SaaS over self-hosted GlitchTip | Accepted |
| [0015](0015-extract-auth-tables-into-db-auth-package.md) | Extract auth tables into `packages/db-auth` | Accepted |
| [0016](0016-app-setting-table.md) | `app_setting` table extends the AI bounded exception | Accepted — single-merchant note amended by [0018](0018-multi-location-architecture.md) |
| [0017](0017-deepseek-replaces-codex.md) | DeepSeek replaces Codex for the AI assistant | Accepted |
| [0018](0018-multi-location-architecture.md) | Multi-location architecture (Location over merchantId) | Superseded by [0818](0818-multi-tenant-platform-architecture.md) |
| [0018](0018-tooling-selection-for-agent-dev.md) | Tooling selection rubric for AI-agent-driven development | Accepted |

> **Note — three shared numbers (the very problem ADR-0037 fixes).** ADR **0014**, **0018**, and **0033** are each used by *two* files (parallel-branch collisions — the rows are not typos). Per the immutability convention below, none was renumbered. When cross-referencing any of them, link the full filename (e.g. `0014-sentry-saas-over-glitchtip.md`) rather than the bare number. These three are the grandfathered exceptions in the `pnpm docs:check` duplicate-number guard; from ADR-0037 onward, PR-number ids make new collisions impossible.
| [0019](0019-decouple-store-identity-from-clover.md) | Decouple store identity from Clover (POS-agnostic store model) | Accepted |
| [0020](0020-adopt-infisical-for-runtime-secrets.md) | Adopt Infisical as the runtime secret source | Accepted |
| [0021](0021-loyalty-crm-domain.md) | Introduce `packages/db-crm` + `apps/crm-api` (loyalty/CRM domain) | Proposed |
| [0022](0022-loyalty-ledger-and-accrual.md) | Loyalty ledger is append-only; accrual is event-driven, idempotent, one-way | Proposed |
| [0023](0023-loyalty-points-legal-posture.md) | Loyalty points are a no-cash-value promotion, firewalled from gift-card stored value | Proposed |
| [0024](0024-membership-crm-customer-identity.md) | Membership/CRM — customer identity is one domain, owned by crm-api, keyed by phone | Proposed |
| [0025](0025-online-ordering-architecture.md) | Online ordering (order-web) architecture & boundaries | Proposed |
| [0026](0026-integration-tests-via-testcontainers.md) | Integration tests via Testcontainers; split unit vs integration lanes | Accepted |
| [0027](0027-clover-online-payment-and-order-bridge.md) | Clover online payment via hosted iframe + an Atomic-Order bridge to the KDS | Proposed |
| [0028](0028-sales-driven-inventory-depletion.md) | Sales-driven inventory depletion via an append-only stock-movement ledger | Proposed |
| [0029](0029-federated-rbac-and-auth-lifecycle.md) | Federated RBAC roles + auth lifecycle for the suite | Proposed |
| [0030](0030-semantic-metric-registry-as-ai-grounding.md) | A governed metric registry is the AI grounding contract | Accepted |
| [0031](0031-profitability-analytics-cost-dimension.md) | Profitability analytics via a cost dimension in analytics-api | Proposed |
| [0032](0032-forecasting-compute-surface.md) | A dedicated forecasting compute surface, off the read-only OLAP path | Proposed |
| [0033](0033-verify-clover-webhook-hmac.md) | Verify Clover webhook HMAC signatures, staged fail-open → fail-closed | Proposed |
| [0033](0033-labor-cost-as-effective-dated-reference.md) | Labor cost as an effective-dated reference dimension (prime cost, Phase 4a) | Accepted |
| [0034](0034-clover-sync-dead-letter-queue.md) | Dead-letter queue + replay API for failed Clover sync events | Proposed |
| [0035](0035-analytics-read-dtos-into-contracts.md) | Move analytics-api read DTOs into @rop/contracts | Proposed |
| [0036](0036-pr-time-image-build-coverage.md) | PR-time Docker image build coverage for all deployed apps | Accepted |
| [0037](0037-adr-ids-are-the-pull-request-number.md) | ADR ids are the pull-request number (parallel-safe numbering) | Accepted |
| [0522](0522-remove-dokploy-and-swarm.md) | Remove Dokploy + Docker Swarm for plain docker compose | Accepted |
| [0526](0526-manage-inventory-catalog-items-vendors-purchase-orders.md) | Manage inventory catalog — items, vendors, purchase orders | Proposed |
| [0527](0527-collapse-to-single-app-network.md) | Collapse all compose stacks onto a single flat app network | Accepted |
| [0538](0538-ai-invoice-scan-for-receiving-via-deepseek-vision.md) | AI invoice scan for receiving via DeepSeek vision | Proposed |
| [0548](0548-labor-cost-write-source-in-inventory-api.md) | Labor-cost write-source is inventory-api (prime cost, Phase 4b) | Accepted |
| [0573](0573-count-based-actual-cogs-and-yield-variance.md) | Count-based actual COGS + yield variance | Accepted |
| [0586](0586-learned-vendor-aliases-for-invoice-receiving.md) | Learned vendor aliases for invoice receiving (one canonical item, many vendor names) | Proposed |
| [0587](0587-ai-semantic-match-for-invoice-receiving.md) | AI semantic match for invoice receiving (confidence-gated tier) | Proposed |
| [0589](0589-per-vendor-price-intelligence.md) | Per-vendor price intelligence from learned aliases | Proposed |
| [0592](0592-operator-confirmed-pack-unit-conversion.md) | Operator-confirmed pack/unit conversion for receiving | Proposed |
| [0626](0626-doc-status-banners-and-link-integrity.md) | Documentation status banners, placement rules, and machine-checked link integrity | Accepted |
| [0638](0638-passkey-lockout-invariant-passwordsetat-and-backoffice-self-service-passkeys.md) | Passkey lockout invariant, `passwordSetAt`, and backoffice self-service passkeys | Proposed |
| [0642](0642-autonomous-scheduler-is-the-one-backfill-implementation.md) | Autonomous scheduler is the one backfill implementation | Accepted |
| [0664](0664-frontend-dev-source-resolution-via-env-gated-turbopack-resolvealias.md) | Frontend dev-source resolution via env-gated Turbopack resolveAlias | Accepted |
| [0670](0670-receipt-image-archive.md) | Archive scanned receipt images in R2, served via inventory-api | Accepted |
| [0727](0727-dead-letter-queue-replay-reuses-the-postgres-table-not-a-new-bullmq-queue.md) | Dead-letter queue replay reuses the Postgres table, not a new BullMQ queue | Proposed |
| [0737](0737-inventory-unit-model-stable-base-unit-per-vendor-packs-and-barcode-mapping.md) | Inventory unit model: stable base unit, per-vendor packs, and barcode mapping | Accepted |
| [0795](0795-posaccount-posstore-unified-store-identity-model.md) | PosAccount → PosStore unified store-identity model | Accepted |
| [0801](0801-notifications-api-owns-the-operator-notification-domain.md) | notifications-api owns the operator notification domain | Proposed |
| [0811](0811-barcode-centric-inventory-onboarding.md) | Barcode-centric inventory onboarding (scan-to-register, OFF auto-fill, internal codes) | Proposed |
| [0818](0818-multi-tenant-platform-architecture.md) | Multi-tenant platform architecture (Toast-style; supersedes [0018](0018-multi-location-architecture.md)) | Proposed |
| [882](882-scan-same-product-multi-size-one-item-many-packs.md) | Invoice scan captures same-product-different-size as one item with many packs | Proposed |

> **Numbering changed at ADR-0037 — ids are now the PR number.** `0001`–`0037` are the legacy contiguous block (the `0014` / `0018` collisions above are why). From `0037` onward, a new ADR is authored as `0000-<slug>.md` and renamed to its **pull-request number** when the PR opens (Rust-RFC style) — GitHub assigns PR numbers atomically, so parallel agents in different worktrees can never collide. Numbering is therefore **non-contiguous** after `0037` (ids jump to PR numbers like `0512`). `pnpm docs:check` fails on a duplicate number or a forgotten `0000-` placeholder. Scaffold with `scripts/new-adr.sh "<title>"`. See [ADR-0037](0037-adr-ids-are-the-pull-request-number.md).

## When to write an ADR

Write one when:

- The decision affects multiple apps or packages.
- The decision constrains future changes (rolls back are expensive).
- The reasoning isn't obvious from reading the resulting code.
- You want to forestall a future "why don't we just …" conversation.

Don't write one for:

- Library / framework version bumps (let `git log` and `pnpm-lock.yaml` carry that).
- Local-to-one-file design choices (a code comment is enough).
- Reversible choices with low blast radius (test framework, lint rule).

## Format

Each ADR follows [Michael Nygard's classic format](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions): **Status · Date · Context · Decision · Consequences · Alternatives considered**. Keep it terse — 150–300 lines max. If you need more, you probably need a follow-up doc, not a longer ADR.

## Template

Scaffold with `scripts/new-adr.sh "<title>"`. The file starts as `0000-<slug>.md` with an `# ADR-0000:` header; **do not pick a number** — rename `0000-` to the PR number once the PR is open (ADR-0037). `pnpm docs:check` reds a committed `0000-` placeholder so you can't forget.

```markdown
# ADR-0000: <Short title — verb phrase>

- **Status**: Proposed | Accepted | Superseded by [ADR-XXXX](./XXXX-...md) | Deprecated
- **Date**: 2026-MM-DD
- **Deciders**: <names or @handles>

## Context

What's the problem? What constraints are in play? Cite the incident,
PR, or memory note that prompted this if applicable.

## Decision

What did we choose? Be specific — "use X" not "be careful about X".

## Consequences

What does this make easy? What does it make hard? What new risks does
it introduce? Include the things future-us will have to live with.

## Alternatives considered

What else was on the table, and why was it rejected? List by name; one
short paragraph each. Including "do nothing" is often valuable.
```

## Superseding an ADR

When a later decision replaces an earlier one:

1. Add a new ADR (its id is its PR number — ADR-0037; scaffold with `scripts/new-adr.sh`).
2. In the new ADR's **Status** line, write: `Supersedes [ADR-NNNN](./NNNN-...md)`.
3. Edit the old ADR's **Status** line: `Superseded by [ADR-MMMM](./MMMM-...md)`.

Never delete an ADR — the history is the point.
