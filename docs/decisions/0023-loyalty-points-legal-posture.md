# ADR-0023: Loyalty points are a promotion with no cash value (and are firewalled from gift-card stored value)

- **Status**: Proposed
- **Date**: 2026-05-30
- **Deciders**: @example-org
- **Related**: [ADR-0021](0021-loyalty-crm-domain.md), [ADR-0022](0022-loyalty-ledger-and-accrual.md)

## Context

The "build the brain, rent the rails" split ([[build-vs-buy-philosophy]]) puts
**loyalty points** on the build side and **gift-card stored value** on the rent
side (Clover native today; Factor4 cross-POS later). The legal reason these
land on opposite sides is unclaimed-property (escheatment) law:

- **Gift cards / stored value** represent prepaid cash and are regulated:
  escheatment to the state in NJ/NY/TX and others, fraud/settlement liability.
  This is exactly why Example Kitchen *rents* that rail.
- **Loyalty points** that carry **no cash value** fall under the 2016 Uniform
  Unclaimed Property Act "loyalty card" exemption and sit **outside**
  escheatment — *as long as they are never sold for money and never cashed out.*

Accounting-wise, points are also a real liability: under ASC 606 / IFRS 15 a
loyalty point that confers a "material right" is a separate performance
obligation (deferred revenue), with breakage recognized **proportionally as
redemptions occur**, not booked up front.

The risk: a careless feature (e.g. "convert points to a gift-card balance" or
"cash out your points") would silently flip points from exempt promotion into
escheatable stored value, importing the very liability we deliberately rented
away.

## Decision

1. **Points are promotional and carry no cash value.** They are never sold for
   money and never redeemable for or convertible to cash.
2. **Program T&C must state plainly:** points/stamps have *no cash value, are
   non-transferable, are not redeemable for or convertible to cash, may expire,
   and are forfeitable on fraud or return.* (This language is a launch
   blocker, not a nicety.)
3. **Hard firewall between the two ledgers.** The `CrmPointsLedger`
   ([ADR-0022](0022-loyalty-ledger-and-accrual.md)) and the gift-card
   stored-value system (Clover/Factor4) are **separate ledgers with separate
   legal treatment**. A points ledger entry must **never** mint gift-card value,
   and vice versa. The `DOLLAR_CREDIT` reward kind ("$5 Store Cash") is an
   **in-program discount applied at redemption against an order**, not a
   transferable stored-value balance and not cash — it is consumed as a coupon,
   tracked by `CrmRewardRedemption`, and dies with its 30-day TTL.
4. **Accounting posture.** Treat outstanding available points as an ASC 606
   contract liability; report `SUM(available) × cost-per-point × (1 − breakage)`
   on the backoffice dashboard; recognize breakage proportionally, not up front.

## Consequences

- The build/rent split stays legally clean: the regulated, escheatable money
  movement stays entirely inside the rented gift-card rail; the built loyalty
  engine stays a promotion.
- Expiry (12-month rolling inactivity, [ADR-0022](0022-loyalty-ledger-and-accrual.md))
  both caps the liability and reinforces the no-cash-value posture.
- A future "points → gift card" or "cash out points" feature is **prohibited by
  this ADR** unless it is re-opened with counsel; the temptation will recur
  because it looks customer-friendly.
- This ADR is documentation/policy only — no code boundary to lint — but it
  gates the T&C copy that must exist before launch and constrains the redemption
  feature set in Phase 5/6.

## Alternatives considered

- **Let points convert to gift-card value** (a unified "wallet"). Rejected:
  flips points into escheatable stored value, imports fraud/settlement liability,
  and defeats the reason gift cards are rented rather than built.
- **Cash-out / refund points for money.** Rejected for the same reason, plus it
  makes the program a money instrument.
- **Ignore the distinction** (treat points loosely). Rejected: the exemption is
  conditional; sloppiness is how a promotion accidentally becomes a regulated
  stored-value product.

## Future work (out of scope here)

- Exact T&C wording (with counsel) before the program launches.
- If a subscription tier (design doc §7, open decision #2) is greenlit, note it
  is billing/stored-value-adjacent and gets its own legal review — it does
  **not** ride this exemption.
