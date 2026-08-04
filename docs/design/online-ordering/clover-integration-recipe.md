# Clover Online-Ordering Integration — Verified Sandbox Recipe

> **Status:** verified end-to-end against the **real Clover sandbox** on **2026-05-31**.
> Companion to [ADR-0027](../../decisions/0027-clover-online-payment-and-order-bridge.md)
> (the decision) — this doc is the **proven implementation recipe** the
> `kds-api` `/api/order/*` build follows.

## Why this doc exists

ADR-0027 chose "Clover Ecommerce hosted iframe + an Atomic-Order bridge" but flagged
four load-bearing facts as **"verify in sandbox before building."** This doc records the
exact, sandbox-tested API calls so the build is grounded in **proven** requests, not docs
guesswork. Several facts here are **not obvious from Clover's documentation** and were only
discovered by direct testing — those are flagged ⚡.

## The one mental model that matters

Clover treats **payment acceptance** and **device-visible orders** as **two separate
systems**:

```
  Ecommerce API  (token-*, scl-* hosts)   →  takes money. Creates only a
                                              payment-side stub. NEVER appears
                                              on a Clover device or the KDS.

  Platform REST v3  (api* host)           →  Atomic Order = a real, device-visible
                                              order. THIS is what fires the "O:"
                                              webhook our existing sync consumes.
```

⚡ **A successful charge alone does not reach the kitchen.** You must explicitly
**Create an Atomic Order** after the charge. That order then flows through the *existing*
`clover webhook → syncOrderById → KdsTicket` pipeline with **zero new sync code** — the
Atomic-Order create is the single mandatory piece of glue (lives in `kds-api`).

## Credentials (Infisical `dev`, names only — never values)

| Key name | Host it authenticates | Role |
| --- | --- | --- |
| `CLOVER_SANDBOX_MERCHANT_ID` | — | merchant scope for all v3 calls |
| `CLOVER_SANDBOX_APP_ID` | — | OAuth app identifier |
| `CLOVER_SANDBOX_APP_SECRET` | — | OAuth secret (rotate — appeared in chat) |
| `CLOVER_SANDBOX_ACCESS_TOKEN` | `apisandbox.dev.clover.com` | Platform REST v3 (customers, orders, atomic orders) |
| `CLOVER_SANDBOX_ECOMM_PUBLIC_KEY` | `token-sandbox.dev.clover.com` | browser-side card **tokenization** (`apikey` header) |
| `CLOVER_SANDBOX_ECOMM_PRIVATE_KEY` | `scl-sandbox.dev.clover.com` | server-side **charge** (`Authorization: Bearer`) |

> 🔒 **Secret posture:** sandbox creds are low-risk. **Production** keys go **only** into
> Infisical/env — never pasted into chat, PRs, or committed files. This doc carries **zero
> secret values**; all sandbox IDs are shown as `${PLACEHOLDER}`.

## End-to-end flow (verified)

```
  order-web (customer's phone)                kds-api                         Clover                 KDS
  ───────────────────────────                 ───────                         ──────                 ───
  1. Clover hosted iframe  ──tokenize──────────────────────────────────────▶  token-* host
     (PUBLIC key, card never                                                  └─▶ clv_… token
      touches our server = SAQ-A)  ◀──────────────────────────── clv_ token ──┘
  2. POST /api/order/checkout ─────────────▶  3. POST /v1/charges (PRIVATE) ─▶  scl-* host
     { clv_ token, cart, name, phone }            x-forwarded-for required      └─▶ succeeded ✅
                                              4. POST /v3 …/customers ────────▶  api* host
                                                 { phoneNumbers:[…] }            └─▶ customerId
                                              5. POST /v3 …/atomic_order/orders▶ api* host
                                                 (ad-hoc line items OK)          └─▶ orderId
                                              6. POST /v3 …/orders/{id}         api* host
                                                 { customers:{elements:[…]} } ─▶ (attach)
                                                                          ┌──── "O:" order webhook ───▶ existing
                                                                          │      syncOrderById            sync →
                                              7. (later) GET …/orders/{id}?     KdsTicket + WS publish ──▶ ticket
                                                 expand=customers.phoneNumbers
                                                 → phone → NormalizedOrder → crm-api accrual (PENDING EARN)
```

## The verified calls (exact, sandbox)

### 1. Tokenize — browser, **public** key

```
POST https://token-sandbox.dev.clover.com/v1/tokens
apikey: ${CLOVER_SANDBOX_ECOMM_PUBLIC_KEY}
Content-Type: application/json

{ "card": { "number":"4242424242424242", "exp_month":"12",
            "exp_year":"2027", "cvv":"123", "brand":"VISA" } }
→ 200 { "id": "clv_…" }     # single-use token; card data never hits our server
```

> In **production** this is done by Clover's hosted iframe via `sdk.js` `createToken()` —
> the raw-card POST above is the **sandbox testing shortcut** (proves the endpoint + key).
> The iframe path keeps us at SAQ-A; **do not** POST raw PANs from our own server (that's SAQ-D).

### 2. Charge — server, **private** key  ✅ verified `status=succeeded, paid=true`

```
POST https://scl-sandbox.dev.clover.com/v1/charges
Authorization: Bearer ${CLOVER_SANDBOX_ECOMM_PRIVATE_KEY}
idempotency-key: <uuid4>          # ⚡ make this deterministic per checkout (see build notes)
x-forwarded-for: <client ip>      # ⚡ REQUIRED — charge is rejected without it
Content-Type: application/json

{ "amount":1100, "currency":"usd", "source":"clv_…",
  "ecomind":"ecom", "capture":true }
→ 200 { "id":"…", "status":"succeeded", "paid":true, "amount":1100, … }
```

### 3. Create customer with phone — server, **access token**

```
POST https://apisandbox.dev.clover.com/v3/merchants/${MERCHANT_ID}/customers
Authorization: Bearer ${CLOVER_SANDBOX_ACCESS_TOKEN}

{ "firstName":"<pickup name>", "phoneNumbers":[{ "phoneNumber":"+1901XXXXXXX" }] }
→ 200 { "id":"<customerId>", … }
```

### 4. Create Atomic Order — server, **access token**  ⚡ this is the device/KDS bridge

```
POST https://apisandbox.dev.clover.com/v3/merchants/${MERCHANT_ID}/atomic_order/orders
Authorization: Bearer ${CLOVER_SANDBOX_ACCESS_TOKEN}

{ "orderCart": { "lineItems": [ { "name":"Strawberry Roll", "price":650 },
                                 { "name":"Boba add-on",    "price":100 } ] } }
→ 200 { "id":"<orderId>", … }
```

⚡ **Ad-hoc line items work** — `{name, price}` with **no `item.id`** is accepted, so the
menu does **not** need pre-seeded Clover inventory to create a valid, priced order. (Linking
to real inventory items is a later refinement, not a blocker.)

### 5. Attach customer to the order — server

```
POST https://apisandbox.dev.clover.com/v3/merchants/${MERCHANT_ID}/orders/${ORDER_ID}
Authorization: Bearer ${CLOVER_SANDBOX_ACCESS_TOKEN}

{ "customers": { "elements": [ { "id":"<customerId>" } ] } }
```

### 6. Read order WITH phone — server  ⚡ the non-obvious one

```
GET https://apisandbox.dev.clover.com/v3/merchants/${MERCHANT_ID}/orders/${ORDER_ID}?expand=customers.phoneNumbers
Authorization: Bearer ${CLOVER_SANDBOX_ACCESS_TOKEN}
→ order.customers.elements[0].phoneNumbers.elements[0].phoneNumber  == "+1901XXXXXXX"
```

⚡ `expand=customers` **alone returns `phoneNumbers: []`** — you **must** expand
`customers.phoneNumbers` to get the number back. This is load-bearing for "online orders
earn": the phone is how the order attaches to a CRM identity for loyalty accrual.

## Refunds

Use the **order-based return**, which supports partials when the order has tax/tip/multiple
lines:

```
POST https://scl-sandbox.dev.clover.com/v1/orders/${ORDER_ID}/returns
```

…**not** charge-based `/v1/refunds` (no partial support with multi-line/tax/tip). A return
fires the order webhook → the accrual **REVERSE** path runs (cancels PENDING points or
writes a negative REVERSE row). See ADR-0022.

## Loyalty tie-in (why all of the above matters)

`phone on order` → `NormalizedOrder.customer` → `crm-api accrueFromOrderCompleted` →
`PENDING EARN` row. Online orders carry a customer+phone, so they earn; in-store orders have
no attached customer and skip as anonymous — **no special-casing**, the presence of a phone
is the switch. (Owner decision 2026-05-31, "online orders earn"; ADR-0022 / ADR-0024.)

## Sandbox → production host map

| Purpose | Sandbox host (verified) | Production host (verify before cutover) |
| --- | --- | --- |
| Tokenize | `token-sandbox.dev.clover.com` | `token.clover.com` |
| Charge / Ecommerce | `scl-sandbox.dev.clover.com` | `scl.clover.com` |
| Platform REST v3 | `apisandbox.dev.clover.com` | `api.clover.com` |

> **Region:** these are **US** hosts. EU merchants use `.eu.` variants. Example Kitchen is US
> (Anytown), so US hosts apply. The host must be **config-driven** (sandbox vs prod), never
> hardcoded — see the build notes.

## Verified vs still-assumed

| Fact | Status |
| --- | --- |
| Tokenize endpoint + public key | ✅ verified (got `clv_` token) |
| Charge succeeds with private key + `x-forwarded-for` | ✅ verified (`status=succeeded, paid=true`) |
| Customer with phone can be created | ✅ verified |
| Atomic Order accepts **ad-hoc** line items (no inventory) | ✅ verified |
| Attaching a customer to an Atomic Order | ✅ verified |
| Phone read back via `expand=customers.phoneNumbers` | ✅ verified |
| Order-based partial returns | ❓ documented, not yet exercised |
| Hosted iframe `sdk.js createToken()` in a real browser | ❓ tested the token **endpoint** directly, not the iframe widget yet |
| API-created Atomic Order actually firing the "O:" webhook into **our** KDS | ❓ pipeline logic confirmed by reading; full e2e pending real endpoints |
| Negotiated CNP fee / exact SAQ letters | ❓ third-party figures; confirm with Clover for the real merchant |

## Build notes (carry these into `/api/order/*`)

- **Hosts are config-driven.** A `CLOVER_BASE_*` (or `CLOVER_ENV=sandbox|prod`) switch picks
  the three hosts. Never hardcode `*-sandbox.dev`.
- **Idempotency.** Derive the charge `idempotency-key` deterministically from the checkout
  session (not a fresh uuid per retry) so a client retry can't double-charge.
- **`x-forwarded-for`** must be the **customer's** IP (from the order-web request), forwarded
  through the BFF → kds-api → Clover.
- **Never log** card data, the `clv_` token, or the private key. Log the charge `id` +
  `status` only.
- **The phone is PII.** It rides to the Atomic Order's customer for loyalty; do not persist
  it in a KDS table — it lives in Clover (source) + crm-api (CRM identity), per Iron Law #1.

## Verified update — the settle/checkout path (2026-05-31, PR3c)

A second sandbox pass (building the actual checkout) corrected several assumptions
above. **These are the load-bearing ones for getting a paid web order onto the KDS:**

- ⚡ **An inline `orderType` is rejected.** Passing `orderType: {taxable: true}` to
  `atomic_order/checkouts` **or** `/orders` fails with **"Referenced order type does not
  exist"**. You must either **omit `orderType`** (no tax — how a bare merchant behaves) or
  **reference a real taxable order type by id** (`orderType: {id}`), resolved from
  `GET /v3/merchants/{mId}/order_types` (prefer the default taxable one). Tax only applies
  via an order-type reference.
- ⚡ **`atomic_order/checkouts` totals are TOP-LEVEL**, not under `orderCart`: the response is
  `{ orderCart, total, subtotal, totalTaxAmount, taxSummaries, isVat }`. Read `total` and
  `totalTaxAmount` off the top.
- ⚡ **Settle via the External Payment tender.** Recording a payment with
  `POST /v3/.../orders/{id}/payments { amount, tender: {id} }`, where the tender is the
  merchant's **`com.clover.tender.external_payment`** tender (from `GET /v3/.../tenders`),
  flips the order's `paymentState` to **PAID** — ✅ **verified**. **It is async (~seconds):**
  the read immediately after returns `OPEN`; a moment later it is `PAID`. The KDS pipeline
  absorbs this naturally (the payment modification re-fires the `O:` webhook → the worker
  re-fetches the now-PAID order). Setting `paymentState` directly via `POST /orders/{id}`
  does **not** work — you must record a payment.
- ⚡ **The order read MUST `expand=payments` to see the PAID flip.** Clover computes
  `paymentState` **lazily**: after the External-Payment settle, the *bare* order field can
  stay `OPEN` indefinitely — only `GET …/orders/{id}?expand=payments` forces a recompute to
  `PAID`. (Same order, same instant, verified: no-expand → `OPEN`; `expand=payments` →
  `PAID`.) **Load-bearing for the KDS:** `kds-api`'s `fetchOrder` / `fetchModifiedOrders`
  expand `…,payments` (next to `customers.phoneNumbers`) — without it the unpaid-skip gate
  (`shouldSkipForUnpaidState`) drops a genuinely-paid online order and it never reaches the
  KDS. (Live-e2e finding 2026-06-02; this is the root cause behind the "❓ does an
  API-created Atomic Order actually reach our KDS" row.)
- The verified settle sequence is therefore:
  `checkouts (quote, top-level total)` → `Ecommerce charge` →
  `createAtomicOrder (omit/resolve orderType)` → `createCustomer + attachCustomerToOrder` →
  `recordOrderPayment (External Payment tender)` → **PAID (async)** → `O:` webhook → KDS.
- **Compensation:** once the charge succeeds, any later failure (order create / payment
  record) **refunds the charge** (`POST /v1/refunds {charge}`). A refund that itself fails is
  logged loudly — the one state that needs a human. (Customer-attach failure is best-effort:
  it forfeits loyalty for that order but does **not** fail/refund the order.)

Updates to the table above: **atomic-order create + customer attach + external-payment→PAID
are now ✅ verified** (sandbox merchant `QZPHD754…`). **2026-06-02 — full live e2e (sandbox):**
the hosted-iframe widget renders + tokenizes a card in a real browser ✅, and a charged order
now flows charge → atomic order → PAID → **KDS ticket** → **loyalty emit** ✅ — after fixing
the `expand=payments` gap above (it was the missing link). Still ❓: exact prod fees/SAQ, and
the production merchant's order-type/tender ids + tax behaviour (confirm before go-live).

## See also

- [ADR-0027](../../decisions/0027-clover-online-payment-and-order-bridge.md) — the decision
- [ADR-0025](../../decisions/0025-online-ordering-architecture.md) — order-web boundaries
- [ADR-0024](../../decisions/0024-membership-crm-customer-identity.md) — phone-keyed CRM identity
- [ADR-0022](../../decisions/0022-loyalty-ledger-and-accrual.md) — accrual / REVERSE semantics
