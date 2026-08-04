# ADR-0586: Learned vendor aliases for invoice receiving (one canonical item, many vendor names)

- **Status**: Proposed
- **Date**: 2026-06-06
- **Deciders**: @example-org
- **Extends**: [ADR-0538](./0538-ai-invoice-scan-for-receiving-via-deepseek-vision.md) (AI invoice scan)

## Context

ADR-0538 shipped AI invoice scanning: photograph a vendor invoice, the vision model
extracts raw line descriptions, and a **deterministic** client step maps each
description to a catalog item (the model never emits a SKU). That mapping
(`apps/backoffice-web/lib/inventory/receipt-match.ts`, `apps/crew-web/lib/scan.ts`)
is a **stateless fuzzy match on item names** — and it has two gaps the owner hit in
practice:

1. **It forgets.** Sam's Club prints `MEMBER'S MARK WHOLE MILK 12 OZ`; the catalog
   item is `Milk 12 oz`. The fuzzy matcher might guess right via the shared `milk/12/oz`
   tokens, but it re-guesses **every** invoice. A correction the operator makes today
   teaches the system nothing for tomorrow.
2. **No notion of "same product, different vendor name."** When the guess is wrong the
   operator either re-points the line (and loses that knowledge next time) or, worst
   case, clicks "create new item" — fragmenting `Milk` into `Milk`, `Member's Milk`,
   `Sysco Milk`. Duplicate-item sprawl is the #1 data-quality failure mode in restaurant
   inventory / AP tools.

The owner asked two design questions:

- **Q1.** When a different vendor's milk arrives, add the quantity to the existing
  `Milk 12 oz`, or create a new item (archiving the old), or keep both?
- **Q2.** Should we strip `Member's` at entry to keep just `Milk 12 oz`, or tag the item
  with brand / size?

Industry consensus (MarketMan, Toast xtraCHEF; ERP MDM literature) is unambiguous:
keep **one master/canonical item** you physically stock and count, and **map many
vendor identities (vendor name, pack, price) to it**; never create a SKU per vendor.
The mapping is **learned** — confirm once, auto-match thereafter ("item matching
memory"). This ADR brings that pattern to the suite.

## Decision

Add a **learned vendor-alias** layer under the existing scan→match→receive flow, in
**both** Floor (`crew-web`) and Backoffice (`backoffice-web`). Five parts.

### D1 — One canonical item is the stock-keeping unit (answers Q1)

The quantity is added to the **existing `Milk 12 oz`**. Decision rule, encoded in the
review UI's defaults: *is it interchangeable on the line / in a recipe?*

- **Yes** (same size, same usage unit) → same canonical item; just receive into it.
- **No** (size/spec genuinely changed, e.g. 12 oz → 16 oz; or a permanent supplier
  switch where the old is discontinued) → new item, **archive** the old (the soft-delete
  `archivedAt` already retains recipe/PO/movement references).
- "Both active, side by side" is reserved for the rare case of stocking two variants you
  count separately — never the default for a commodity like milk.

### D2 — A learned alias table: `inventory_item_aliases`

A new table maps a vendor's printed text to a canonical item:

```
(vendor, normalized) ──unique──▶ item_id   [+ raw, brand, pack, last_cost_cents, hits]
```

`normalized` is `normalizeAlias(rawDescription)`; `vendor` is `normalizeAlias(vendorName)`
(`""` = vendor-agnostic). On **receive confirm**, every committed line that resolved to
an item (matched *or* freshly created) **upserts** its alias. The next invoice from that
vendor hits the alias exactly — zero AI, instant, deterministic. A re-map overwrites
`item_id` (the operator correcting a bad guess *is* the training signal). One canonical
item accumulates many aliases.

This is additive and reuses the existing idempotent ad-hoc-receive transaction; no new
write path to stock.

### D3 — Tiered, deterministic matching (model still never emits a SKU)

`bestCatalogMatch` / `matchDescription` resolve a line in order:

0. **Learned alias** — exact `(vendor, normalized)`, else the same `normalized` across
   any vendor when unambiguous. **High confidence** → auto-selected, surfaced as
   "matched from memory".
1. **Fuzzy** — name / SKU containment, then token overlap, run over the AI's
   `canonical_name` when present (cleaner than the raw line) else the raw description.
   **Medium confidence.**
2. **No signal** → "create new item" with the AI canonical name pre-filled.

ADR-0538 D3/D4 are preserved verbatim: the model proposes, the human commits, and SKU
resolution is deterministic on the client.

### D4 — AI does the normalization, not a destructive rewrite (answers Q2)

The vision step (ADR-0538's single call — no new request, no new cost) additionally
returns per line an optional `canonical_name` (`Milk 12 oz`), `brand` (`Member's Mark`),
and `pack` (`12 oz`). We **never** strip `Member's` from stored data:

- The **canonical item name stays clean** (`Milk 12 oz`); `canonical_name` pre-fills it
  when creating a *new* item.
- The **raw printed text is preserved** as the alias `raw` (needed for auto-match + audit
  + future price comparison).
- **Brand is a vendor-product attribute**, stored on the alias (`brand`) — **not** a
  free-floating tag on the canonical item (a tag would wrongly imply the item *is* that
  brand; the item is brand-agnostic, its aliases carry brands).

### D5 — Shared normalization in `packages/contracts` (no drift)

`normalizeAlias`, the alias index, and the exact-alias resolver live in
`packages/contracts` and are imported by inventory-api (writing the key) and **both**
web matchers (reading it). One function, so the stored key and the lookup key can never
diverge across three codebases (Iron Law 2).

## Consequences

- **Easy**: matching gets better every time the operator confirms; the catalog stays
  clean (one `Milk`); `raw` + `last_cost_cents` per vendor seed a later price-comparison
  view; an empty store still bootstraps from invoices (D2 learns on the create path too).
- **Hard / new risks**:
  - **Vendor-name variance** (`Sam's Club` vs `Sams`) can miss the vendor-scoped key; the
    vendor-agnostic fallback (D3.0) covers it when the description is unambiguous.
  - **Mis-mapping**: a wrong confirm teaches a wrong alias. Mitigation: re-mapping
    overwrites it; `hits`/`last_seen_at` let a later UI surface low-trust aliases.
  - `canonical_name`/`brand`/`pack` are **optional** model output — the flow degrades to
    the D3.1 fuzzy path when they're absent, so a weaker vision model never blocks receiving.
- **Cost**: zero additional AI calls — the enrichment rides the existing vision request.
- **Deferred (future phases, not this PR)**: per-vendor **pack/unit conversion** + a cost
  strategy (moving-average vs last-price) so quantities/costs from different pack sizes
  reconcile; a **price-comparison** surface; a dedicated **AI semantic-match** endpoint
  with a confidence threshold for the residual hard cases; teaching the AI chat
  `record_receiving` / `find_inventory_item` tools to read aliases; promoting the alias
  row to a full vendor-product entity if a multi-vendor order guide matures.

## Alternatives considered

- **A SKU per vendor** (`Member's Milk` separate from `Milk`). Rejected — the documented
  industry anti-pattern: fragments on-hand, breaks one-par/one-recipe, explodes counting.
- **Strip the brand destructively at entry.** Rejected — loses the auto-match signal, the
  audit trail, and any future price comparison; one-way lossy.
- **Brand as a free tag on the canonical item.** Rejected — brand is inherently
  per-vendor; it belongs on the alias, not on the brand-agnostic item.
- **Trust the model to emit the catalog SKU.** Rejected by ADR-0538 and unchanged here —
  invites hallucinated/duplicate SKUs into the ledger.
- **Do nothing (keep stateless fuzzy).** Rejected — it re-guesses forever and never
  learns from the operator's corrections, which is the whole ask.
