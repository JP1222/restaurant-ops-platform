# ADR-0592: Operator-confirmed pack/unit conversion for receiving

- **Status**: Proposed
- **Date**: 2026-06-06
- **Deciders**: @example-org
- **Extends**: [ADR-0586](./0586-learned-vendor-aliases-for-invoice-receiving.md) (learned vendor aliases)

## Context

Receiving adds the invoice's printed quantity **straight to on-hand** (`inventory-store.ts`
`onHand + line.qty`). Invoices price by a **purchase** unit ("2 cases @ $50") while stock is
tracked in a smaller **stock** unit ("each"), so "2 cases" of a 12-pack lands as **2 each, not
24**, and the $50/case is recorded as $50/each — corrupting both on-hand and unit cost / COGS.
The item already carries its pack shape (`purchase_unit` + `pack_qty`, used by the cost
calculator), so the conversion is knowable; it just isn't applied at receive time.

Because this is stock **and** cost math, the bar is: never silently mis-count.

## Decision

Convert at receive, but **operator-confirmed and client-side**.

### D1 — A confirmed toggle on the review row

When a line is matched to an item with `pack_qty > 1` and the invoice unit reads like that
item's pack (`looksLikePackUnit`: the configured purchase unit, or a known pack word —
case/box/ct/dozen/…), the review row shows a **"Received by case (×12)"** toggle, pre-checked
from the detected unit, with a live **"= 24 each · $4.17/each"** preview. The operator sees and
confirms (or unchecks/edits) the exact numbers before commit — nothing is auto-applied unseen.

### D2 — Convert in the client; server math unchanged

The conversion happens before the receive call; the API still receives **stock-unit qty +
per-stock-unit cost**, exactly as today. So there's no migration, no server change, and no path
by which a wrong guess silently corrupts on-hand — the committed numbers are the ones shown.

### D3 — Price assumption (and its escape hatch)

The invoice line cost is taken as **per its stated unit** (per case), so per-each =
`cost / pack_qty`. This is the common invoice format; when it's wrong, the operator sees the
derived per-each price on the row and overrides the cost. Human-in-the-loop covers the
ambiguity rather than a guess hard-coded into stock math.

### D4 — Pure, tested helper

`looksLikePackUnit` + `convertForReceive` live in `lib/inventory/pack.ts`, unit-tested
(2 cases @ $50 of a 12-pack → 24 @ $4.17; pass-through when off or pack_qty ≤ 1; absent cost
stays absent).

### D5 — Scope

The **backoffice receive intake sheet** lands here. **crew-web's scan** and the **AI chat
receipt card** reuse the same helper (follow-up), as does persisting the "received as a pack"
**intent** for audit (today only the converted stock-unit values are stored).

## Consequences

- **Easy**: scanned invoices now produce correct on-hand *and* unit cost; entirely
  human-confirmed; no schema or server change; the default detection handles the common case
  with one glance.
- **Limits**: only fires for matched items that have a configured pack; the per-pack price
  assumption (D3) may need an override; the purchase-unit intent isn't persisted yet (D5).
- **Risk**: a wrong auto-default just means the operator unchecks the row — it can't silently
  mis-count, because the converted qty/cost are shown, confirmed, and the server math is the
  same code path as a hand-typed receive.

## Alternatives considered

- **Auto-learned pack factor, applied automatically.** Rejected for v1 — it would auto-apply a
  parsed factor to stock + cost math with no human in the loop, the exact silent-corruption
  risk this ADR avoids. Revisit once the confirmed flow has proven the detection on real
  invoices.
- **Server-side conversion via a new contract field** (send qty + purchase-unit intent, let the
  API multiply). Heavier (contract + API + migration for the intent) and not needed for correct
  numbers. Deferred; pairs naturally with persisting the intent (D5).
- **Do nothing.** Leaves the "2 cases → 2 each" miscount and per-case-as-per-each cost. Rejected.
