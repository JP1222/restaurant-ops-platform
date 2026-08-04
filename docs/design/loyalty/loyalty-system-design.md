# Example Kitchen Loyalty / Points System — Design

- **Status**: Draft (Phase 1 of the build)
- **Date**: 2026-05-30
- **Owner**: @example-org
- **Grounded in**: an 8-agent research + codebase-grounding workflow (May 2026). Industry numbers decay — re-verify competitor terms before a relaunch.
- **Companion ADRs**: [0021](../../decisions/0021-loyalty-crm-domain.md) (db-crm + crm-api), [0022](../../decisions/0022-loyalty-ledger-and-accrual.md) (append-only ledger + accrual hook), [0023](../../decisions/0023-loyalty-points-legal-posture.md) (no-cash-value legal posture).
- **Engine spike**: [`points-earn-rules.ts`](./points-earn-rules.ts) — the pure earn/redeem policy.

> **Build-the-brain, rent-the-rails.** Loyalty/CRM is code + business logic with low external liability → we **build** it. Payment processing and gift-card **stored value** carry money-movement / escheatment liability → we **rent** them (Clover today, Factor4 for cross-POS gift cards later). Points are *promotional* (no cash value) and are therefore **not** stored value — see ADR-0023.

---

## 1. Purpose & scope

Design a **POS-agnostic, multi-location loyalty/points program** that Example Kitchen owns end-to-end: it accrues points from completed orders on any POS (Clover today; possibly Toast/Square at future stores), lets customers redeem app-side, and rolls up across all of the owner's stores keyed by phone number.

**Not** in scope: multi-tenant SaaS isolation (all stores are the owner's), gift-card stored value (rented), payment processing (rented).

---

## 2. Industry research summary

The whole QSR/dessert/drink category clusters at a **~5–10% effective give-back** on the headline reward. The perceived generosity comes from a **big, visible reward at a high threshold**, not a high percentage.

**Effective give-back % is the only dial that matters.** The headline rate is cosmetic:

> `effective give-back = reward value ÷ dollars spent to earn it`
> `10 pts/$1` and `1 pt/$1` are economically identical. A bigger, faster-jumping number (every $6 boba = +60) just *feels* more rewarding. (Kung Fu Tea uses "2 bubbles/$1"; Smoothie King inflates to 100 pts/$1 — same ~8% economics.)

**Competitor benchmarks (May 2026):**

| Program | Rate | Basis | Flagship reward | Effective give-back |
|---|---|---|---|---|
| Chipotle (relaunched Apr 2026) | 10 pts/$1 | pre-tax, food only | free entrée @ 1,625 pts | ~6% |
| Cava | 10–12 pts/$1 (tiered) | per $1 | bowl @ ~500 pts | ~6% |
| Dunkin' | 10 pts/$1 (→12 Boosted) | pre-tax | free coffee @ 150 pts | ~5% |
| Chick-fil-A One | 10–13 pts/$1 (tiered) | pre-tax | à-la-carte ladder | ~6% |
| Starbucks (overhauled Mar 2026) | 1–2 ★/$1 | pre-tax | **60★ = $2 off anything**; tiers w/ $-caps | ~3–6% |
| Crumbl | 10–13 pts/$1 (tiered) | per $1 | **100 Crumbs → $10 Crumbl Cash** | ~10% (outlier) |
| Smoothie King | 100 pts/$1 | per $1 | reward @ 2,500 | ~8% |
| Panera | **subscription** $14.99/mo unlimited drinks | — | — | highest frequency driver |

**Behavioral levers worth copying (with sources):**

- **Endowed-progress effect** (Nunes & Dréze): a head-start shortens perceived distance → **signup bonus** (credit ~25% toward the first reward).
- **Goal-gradient effect** (Kivetz, Urminsky & Zheng 2006): people accelerate near a reward → **progress bar** ("80/100 — 1 away").
- **Loss aversion + expiry**: "your points expire in 7 days" drives redemption harder than "earn points!" — but budget for **breakage** (10–30% of points never redeemed).
- **Digitize the punch card**: paper redeems <10% (lost in the wash); the same reward delivered digitally redeems 30%+ and lifts frequency 30–40%, *and* you get the customer data + ROI measurement a stamp card can't.
- **Phone-number-at-checkout > app download**: "nobody wants another app for a place they visit twice a month." The boba/froyo crowd is 15–30, social-native — **referral + UGC is the growth engine, not just retention.**

---

## 3. Recommended parameters

These are the **starting** parameters (owner-tunable — see §7 Open decisions). They live in code/data so the policy changes without re-architecting: rate + provider rules in [`points-earn-rules.ts`](./points-earn-rules.ts), reward rungs in the `REWARD_CATALOG` constant → later the owner-editable `CrmReward` table.

| Knob | Value | Why |
|---|---|---|
| **Basis** | pre-tax subtotal of **eligible lines only** | Industry norm; protects margin; blocks gift-card point-farming |
| **Exclusions** | tax, tip, delivery/service fees, gift-card load lines, reward-redeemed lines, refunded lines, 3rd-party/Deliverect orders | No payment signal / double-dip / margin |
| **Rate** | **10 pts / $1** | Cosmetic but Dunkin/Chipotle-familiar |
| **Rounding** | `Math.floor`, integer-cents math | Never over-credits; explainable on a counter card |
| **Effective give-back** | **~7–8.5% blended** | Generous end of the 5–10% F&B band; affordable because drinks/toppings are high-margin; deliberately under Crumbl's ~10% |
| **Points expiry** | 12-month **rolling inactivity** (any purchase resets) | Chipotle/Chick-fil-A goodwill posture; avoid Dunkin/Dutch-Bros rolling-from-earning (punishes occasional customers) |
| **Coupon expiry** | 30 days from issue | Forces a return visit on a deadline (Cava/Dutch Bros) |

**Reward ladder** (low-threshold, multi-rung → a reward fires every ~1–8 visits, always a near-goal):

| Points | Reward | Value | Spend to earn | Give-back | Role |
|---:|---|---|---:|---:|---|
| 100 | Free topping / boba add-on | ~$1 (COGS ~$0.30) | $10 | 10% | Fast first win / loss-leader |
| 175 | Free size-up / single boba | ~$1.25 | $17.50 | ~7% | COGS-only upsell |
| 300 | **$2 off any order** | $2 | $30 | 6.7%* | Fires on small tickets (*=33% off a $6 ticket) |
| 600 | **$5 Store Cash** (credit toward anything) | $5 | $60 | 8.3% | Crumbl-style, nudges high-margin add-ons |
| 850 | Free regular rolled ice cream / boba / smoothie | ~$6.50 | $85 | ~7.6% | Headline buy-X-get-1 (~6–8 visits) |
| 1200 | Free large / premium creation | ~$8.50 | $120 | ~7.1% | Aspirational top rung |

**Near-free, high-leverage extras:**
- **Signup bonus: 200 pts**, held `PENDING` until first qualifying purchase (kills signup farming). ~24% of the way to the first free drink — endowed progress.
- **Referral: double-sided** — referrer +200 pts, friend a free topping — both credited only **after the friend's first $5+ purchase**. Cap ~5/account/month.
- **Birthday: free regular item during the birthday *month***, 30-day window, gated behind **≥$15 lifetime spend** (anti-freeloader). Cheapest re-activation trigger + the reason to capture phone + birth-month at signup.
- **No tiers at launch.** A single shop lacks the volume; an uncapped top-tier multiplier can blow past 10%. Add a visit-gated "boost" later if data shows a high-frequency cohort.

> **The program is really a phone-number/CRM acquisition vehicle.** The points are the hook; the asset is the customer list + behavior data that no native-POS silo gives you across heterogeneous stores.

---

## 4. Architecture

**POS-agnostic by construction:** the loyalty engine consumes the canonical `NormalizedOrder` (contracts), never a Clover-specific shape. Per-POS adapters already normalize Clover + Deliverect; future Toast/Square plug in at the same seam.

### 4.1 New components

| Component | Mirrors | Role |
|---|---|---|
| `packages/db-crm` | `packages/db-inventory` | Own Postgres (Iron Law #1). `PrismaPg` adapter, `createPrismaClient(CRM_DATABASE_URL)`, `Crm`-prefixed models, baseline migration. The ledger is append-only/high-write → do **not** co-locate in postgres-kds. |
| `apps/crm-api` | `apps/inventory-api` | Owns the loyalty domain: accrual worker, customer read APIs (balance/history/rewards/enroll), redemption issue/void, nightly expiry. **Accrual lives here, not in kds-api** (separate DB, independent scaling, keeps kds-api a pure POS-sync service). |
| `packages/contracts/src/loyalty.ts` | `inventory.ts` | All cross-app loyalty DTOs (Iron Law #2): `OrderCompletedEvent`, `LoyaltyBalanceResponse`, `RewardCatalogResponse`, `EnrollRequest`, `RedeemRequest/Response`. |
| (optional) `packages/loyalty-engine` | — | Pure earn/expiry/redeem math (the [`points-earn-rules.ts`](./points-earn-rules.ts) spike). No db, no Fastify. Phase-1-safe. May instead live as `crm-api/src/domain`. |

### 4.2 Data model (`db-crm`)

| Model | Purpose | Key fields |
|---|---|---|
| `CrmCustomer` | Loyalty identity, **keyed by phone** (cross-store join key) | `phoneE164` (unique), `birthMonth?`, `marketingSmsConsent`, `fraudHold` |
| `CrmLoyaltyAccount` | 1:1 cached **projection** so reads never sum the ledger; brand-global balance | `balancePoints`, `pendingPoints`, `lifetimeEarned/Redeemed`, `lifetimeEligibleSpendCents`, `lastActivityAt`, `balanceVersion` |
| `CrmPointsLedger` | **Append-only source of truth.** Immutable signed-delta rows | `type` (EARN\|REDEEM\|REVERSE\|EXPIRE\|ADJUST\|BONUS), `points` (signed), `status` (PENDING\|AVAILABLE\|REVERSED), `source`, `sourceId` (**UNIQUE per (source,sourceId,type)** → idempotency), `reversesLedgerId?`, `eligibleSubtotalCents?`, `merchantId`, `locationId?`, `occurredAt` |
| `CrmReward` | Reward catalog (owner-editable from backoffice → params change without deploy) | `slug`, `costPoints`, `kind`, `valueCents`, `couponTtlDays`, `minLifetimeSpendCents?` |
| `CrmRewardRedemption` | Issued app-side coupon (short TTL), paired with a REDEEM debit row | `code`, `status` (ISSUED\|REDEEMED\|EXPIRED\|VOIDED), `expiresAt`, `ledgerId` |
| `CrmReferral` | Double-sided referral state (bonus only after friend's $5+ first order) | `referrerAccountId`, `referredPhoneE164`, `status`, `qualifyingOrderSourceId?` |

### 4.3 Integration flow (grounded in real files)

> **Load-bearing correction:** `NormalizedOrderSchema` (`packages/contracts/src/index.ts:270-284`) and `NormalizedOrderItemSchema` (`:256-268`) carry **no** total/price/subtotal/tax today — `normalize-order.ts:103` deliberately drops Clover line-item price. The accrual worker therefore **cannot earn** without an additive **monetary block** on `NormalizedOrder` (see ADR-0022). Without it the worker would re-read `rawOrder` and re-parse Clover's shape — leaking Clover structure into crm-api, violating Iron Law #2.

1. Order completes in Clover → `POST /api/clover/webhooks` (`apps/kds-api/src/routes/clover.ts:249`).
2. `createProviderEvents()` / `enqueueProviderEvents()` (`provider-ingress.ts:15,43`) fingerprint-dedupe → enqueue a `SyncOrderJob`.
3. Worker `processSyncJob` (`lib/queue/handlers.ts:19`) → `syncOrderById` → `normalizeOrder` (`domain/normalize-order.ts:103`) → `syncNormalizedOrder` (`lib/sync-order.ts:260`).
4. `shouldSkipForUnpaidState` (`sync-order.ts:126`) gates on `paymentState` — **this is the canonical "order completed" signal** (PAID), **not** `KdsTicket` COMPLETED (that's kitchen-done).
5. **HOOK POINT** — immediately after the `$transaction` commits (`sync-order.ts:421`), enqueue an `order.completed` event (carrying the NormalizedOrder + the new monetary block) to a **new BullMQ queue `crm-loyalty-accrual`** (kds-api = producer; `idempotencyKey = internalOrderId`). Fire-and-forget with a `deadLetterJob` fallback (mirror `enqueueFulfillmentWriteBack` at `sync-order.ts:158-189`) — a loyalty outage must **never** stall order sync. **One-way push only**: crm-api never pulls back from kds-api (avoids a service dependency loop).
6. crm-api accrual worker: filter eligible items → `Math.floor(eligibleSubtotalCents/100 × 10)` → INSERT `EARN` row `status=PENDING`, `sourceId=internalOrderId` (UNIQUE → replay is a no-op). After the return window, promote `PENDING → AVAILABLE`.
7. Refund/void webhook → same pipeline emits `order.refunded` → worker writes a `REVERSE` row (or cancels the still-`PENDING` one).
8. **Redemption is app-side/out-of-band:** customer redeems via marketing-site/SMS → crm-api debits a `REDEEM` row + issues a `CrmRewardRedemption` coupon (30-day TTL); staff scan/key the code at the counter. **Nothing is written back into Clover/Toast** (write-back is POS-gated → app-side keeps us POS-agnostic).
9. Nightly **expiry job** (crm-api scheduler) writes `EXPIRE` rows past 12-mo inactivity + lapses coupons.

### 4.4 Ledger design

Append-only, event-sourced — a mutable balance column corrupts and can't be audited or reversed cleanly.

- **(a) Idempotency** — DB `UNIQUE (source, sourceId, type)`. POS webhooks + BullMQ are at-least-once; a replayed accrual INSERT-conflicts into a no-op. The nightly reconcile re-sync is therefore safe.
- **(b) PENDING-by-default** — EARN inserts `PENDING`, promotes to `AVAILABLE` only after the refund window. This single choice kills **return-after-earn** fraud (the #1 exploit). `balancePoints = SUM(points WHERE AVAILABLE)`.
- **(c) Reversals** — a refund is a **new** signed-negative `REVERSE` row (`reversesLedgerId → EARN`), never an edit. Still-pending → cancel in place. Partial refund → recompute eligible subtotal, post a delta.
- **(d) Projection** — `CrmLoyaltyAccount.balancePoints` is a cache; a reconcile job re-sums the ledger and compares (`balanceVersion`) to detect drift (ledger-snapshot pattern).
- **(e) Expiry** — scheduled `EXPIRE` rows cap the deferred-revenue liability + reinforce the no-cash-value posture.
- **(f) Time** — `occurredAt` uses `order.modifiedAt` (provider clock), not server time, to avoid kds-api/crm-api clock skew.
- **(g) Accounting** — fixed cost-per-point → liability = `SUM(available) × cost-per-point × (1 − breakage)` is trivially reportable on the backoffice dashboard.

---

## 5. Legal posture (see ADR-0023)

Points are a **promotional program with NO cash value**. They are never sold for money and never cashed out → they stay inside the 2016 Uniform Unclaimed Property Act "loyalty card" exemption, **outside** gift-card escheatment (which *does* bind the separate Factor4 gift-card stored-value system).

- Program T&C must state: *"no cash value, non-transferable, not redeemable for cash, may expire, forfeitable on fraud/return."*
- **Firewall:** points must **never** convert into gift-card value or be cashed out — that flips them into escheatable stored value (NJ/NY/TX). Two separate ledgers, two separate legal treatments. This keeps the build-the-brain / rent-the-rails split legally clean.
- Accounting: points are an **ASC 606 / IFRS 15 contract liability** (a "material right"). Recognize breakage *proportionally as redemptions occur*, not up front.

---

## 6. Phased build plan

| Phase | Deliverable | ~LOC | Crosses a boundary? |
|---|---|---:|---|
| **1** ✅ | Pure engine + design doc + ADR drafts. `points-earn-rules.ts` (earn/redeem policy + reward catalog), `loyalty-system-design.md`, ADR-0021/0019/0020. **Nothing imports a db client → no Iron Law touched.** | ~500 | **No** (this PR) |
| **2** | `packages/db-crm` — schema (6 models) cloned from db-inventory, baseline migration, eslint boundary rule, doc-drift + ARCHITECTURE.md registration. | ~500 | **Yes** → ADR-0021 |
| **3** | `apps/crm-api` skeleton + read APIs (enroll/lookup by phone, balance, history, reward catalog) + seed the 6 rungs. Dokploy crm-api project + Postgres. | ~750 | **Yes** → ADR-0021 |
| **4** | Accrual spine: `order.completed` hook in kds-api (`sync-order.ts:421`) + new queue + the `NormalizedOrder` **monetary block** contract change (with iOS Swift contract regen) + crm-api accrual worker (PENDING EARN, promotion, REVERSE-on-refund). | ~700 | **Yes** → ADR-0022 |
| **5** | Redemption (app-side coupon issue/void + staff validate) + nightly expiry job + fraud guards (PENDING gate, referral-qualifies-after-$5, velocity flag). | ~600 | **Yes** → ADR-0022 |
| **6** | Customer UI (marketing-site phone enroll, goal-gradient progress bar, redeem → SMS coupon) + SMS sender + backoffice operator dashboard (redemption rate, member AOV lift, outstanding-points liability). | ~900 | **Yes** |

Each boundary-crossing phase is a separate PR gated on its ADR being accepted.

---

## 7. Open decisions (owner sign-off)

1. **Reward economics sign-off** — confirm the ~7–8.5% blended give-back and the exact menu values per rung against real Anytown COGS. *Only the owner knows true food cost + acceptable liability.*
2. **Subscription tier — DECIDED: no (2026-05-30).** A Panera-Sip-Club analog ($14.99–19.99/mo, one drink/day) is the strongest frequency driver for a daily-habit product, **but** it's billing/stored-value-adjacent (rent-the-rails) and a bigger build. The owner declined it; revisit only if a daily-habit cohort proves out. Membership stays **free enrollment** — see [ADR-0024](../../decisions/0024-membership-crm-customer-identity.md).
3. **3rd-party / Deliverect earn?** — recommended **no** (no payment signal + thin margin). In-store-only acceptable for launch?
4. **SMS provider + TCPA consent wording** — SMS is the primary channel; per-message cost + compliance. (Twilio etc.)
5. **Birthday gate** — $15 lifetime threshold; solo freebie vs Cold-Stone-style BOGO (brings a +1 paying guest).
6. **Cross-store liability settlement** — points earned at store A and burned at store B is an inter-store value transfer. Internal settlement in the partner agreement, or ignored as immaterial at brand scale?

---

## 8. Risks

- **Monetary block is load-bearing** (§4.3) — must land in Phase 4 with the accrual worker, or accrual leaks Clover shape into crm-api.
- **Order-completed vs kitchen-completed** — accrue on `paymentState` (`sync-order.ts:126`), never on `KdsTicket` COMPLETED, or you mis-time/double-count recalls.
- **Reconciliation double-accrual** — the `UNIQUE (source,sourceId,type)` constraint is **mandatory**, not optional; the nightly re-sync replays orders.
- **Deliverect orders have `paymentState=null`** — default earn 0 or risk crediting unpaid/refunded orders.
- **Low threshold + low breakage = higher real cost** — the 100-pt topping fires every ~$10; budget liability near the top of the band (7–8% of redeemed spend), not the sticker number.
- **Legal foot-gun** — never let points convert to gift-card value/cash (ADR-0023).
- **Phone identity edge cases** — number recycling, shared family numbers, E.164 normalization. The phone *is* the cross-store key → normalization must be rock-solid before launch.
- **crm-api availability must not block order sync** — fire-and-forget enqueue + deadLetterJob; add monitoring (none today).
