# ADR-0589: Per-vendor price intelligence from learned aliases

- **Status**: Proposed
- **Date**: 2026-06-06
- **Deciders**: @example-org
- **Extends**: [ADR-0586](./0586-learned-vendor-aliases-for-invoice-receiving.md) (learned vendor aliases)

## Context

The learned-alias layer (ADR-0586) already records, per `(vendor, wording) → item`, the most
recent price paid (`last_cost_cents`). That's the raw material for the question the owner
actually asks at reorder time — *"who's cheapest for this?"* — but nothing surfaces it yet,
and the alias only stores the **normalized** vendor key (`samsclub`), not a name fit to show.

## Decision

Turn the captured per-vendor cost into a read-only price view. Small, safe, additive.

### D1 — Store a readable vendor label on the alias

Add `vendor_label` (the raw vendor name as typed/printed, e.g. "Sam's Club") next to the
normalized `vendor` match key. `learnAlias` fills it from the receive's vendor; the match key
is unchanged, so matching behavior is untouched. A vendor-less receive never blanks an
earlier label.

### D2 — A shared, leaf-imported helper

`vendorPricesForItem(itemId, aliases)` in the `@rop/contracts/match` leaf (client-safe,
no barrel — the Phase-1 Turbopack lesson) returns the per-vendor last price, **cheapest first**:
one row per vendor (the priced wording with the most `hits` wins when a vendor has several),
aliases with no price skipped, display name = `vendor_label` or a prettified key. Unit-tested.

### D3 — A "Vendor prices" readout on the item detail

The backoffice item-detail sheet renders the list (cheapest flagged), computed client-side
from the dataset's `item_aliases` — no new endpoint, no extra fetch, no AI cost.

### D4 — Scope

The readout lands here. The **AI tool** ("where's X cheapest / what am I paying for X across
vendors") that exposes the same helper to the floating assistant is the immediate follow-up
(it needs a small AI-inventory backend join, kept separate to keep this PR safe).

## Consequences

- **Easy**: a savings signal at the point of decision, built entirely on data already
  captured during receiving; zero new infra and zero AI cost.
- **Limits**: shows only vendors you've actually received from *and* that had a legible price;
  it's *last paid*, not a live quote; an ad-hoc (unregistered) vendor shows a prettified key
  until it's seen with a clean label. All acceptable for a v1 reorder aid.
- **Future**: the AI tool (D4); optional reconciliation with `InventoryVendorQuote`; a
  price-trend / last-seen column once the alias carries a timestamp in its DTO.

## Alternatives considered

- **A dedicated vendor-quote entity.** Heavier (its own write path + UI); the alias already
  carries the last cost for free, so this view needs no new entity. Deferred.
- **Derive prices from PO history.** PO lines don't persist a reliable per-line cost
  (ADR catalog-management D3), and ad-hoc receives have no PO at all — the alias is the
  simpler, more complete source.
- **Do nothing.** Leaves captured per-vendor cost invisible, wasting the one signal that most
  directly drives a cheaper reorder. Rejected.
