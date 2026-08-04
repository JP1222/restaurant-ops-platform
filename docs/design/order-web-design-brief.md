# Example Kitchen — Online Ordering Web App (`order-web`) Design Brief

> **Audience:** the designer (e.g. a Claude design session) producing the screens, flows, and
> component library for Example Kitchen's customer-facing online-ordering web app.
> **Goal of this brief:** define the *entire* customer experience up front — every screen, state,
> and pattern — so we design it once and don't churn later. Design the full system cohesively;
> see §14 for what gets *built* first.

---

## 0. How to use this brief

- Treat §4 (Brand) and §10 (Design system) as **non-negotiable foundations** — everything must be
  built from these tokens and components so the app is unmistakably Example Kitchen and internally consistent.
- §7 specifies each screen; §9 lists every state/edge case that MUST be designed (these are the ones
  teams forget and retrofit painfully).
- §13 lists technical constraints the design must respect — do not design around payment/loyalty in a
  way the backend can't deliver.
- Deliver mobile-first (375px) screens first, then tablet/desktop. QSR/dessert ordering is
  overwhelmingly phone-based.

---

## 1. Product context

- **Example Kitchen** is a fast-casual **rolled ice cream + bubble tea + smoothie** shop. Anytown, ST
  (Anytown Mall), since 2024. One location today, **expanding to multiple of the owner's own stores**.
- The hook is **theater**: ice cream is hand-rolled on a frozen pan in front of you — "5 minutes, one
  frozen pan, a tiny show just for you." The app's job is **"order from your phone, skip the line"** —
  order-ahead for pickup; the in-store show still happens when they arrive.
- This is a **dessert/beverage** experience, not a utilitarian meal app. The UI should feel **fun,
  warm, playful, Instagram-worthy** — while still being fast and frictionless.
- **v1 scope: order-ahead pickup at one store.** Delivery and multi-location switching come later
  (design must *accommodate* them — see §14 — but v1 ships single-store pickup).

## 2. Users & primary jobs

| User | Primary job | Design implication |
| --- | --- | --- |
| First-time guest (often walk-by / mall traffic, on phone) | Browse, build a custom treat, pay, skip the line | Zero-friction **guest checkout**; fast menu; delightful customization |
| Returning regular | Re-order a favorite in 1–2 taps; earn/redeem points | "Order again" rail; loyalty woven into the flow |
| Gift buyer | Buy/send a gift card | Simple gift flow with message + delivery |

Assume the customer is **on a phone, one-handed, possibly in a hurry or standing in a mall.**

## 3. Design goals & principles

1. **Brand-forward & joyful.** Lean into the playful ice-cream-parlor identity (§4). This is a treat — the UI should spark a little delight (tactile buttons, soft pastels, tasteful motion) without sacrificing speed.
2. **Frictionless ordering.** Fewest taps from menu → paid. Guest-first. Live running total. Never lose the cart.
3. **Mobile-first, thumb-first.** Primary actions in the bottom thumb zone; sticky cart bar; bottom sheets for quick choices.
4. **Customization is the centerpiece.** Rolled ice cream and boba are highly customizable — the item builder must make this fun and clear, not overwhelming.
5. **Loyalty woven in, not bolted on.** Phone-number enrollment *inside* checkout; points/next-reward visible while ordering.
6. **Inclusive & compliant.** WCAG 2.2 AA (restaurants are the #1 ADA-sued web sector — see §11).
7. **Fast = converting.** Skeletons, optimistic UI, optimized imagery.
8. **Design every state.** Empty/loading/error/closed/sold-out/payment-fail are first-class (§9).

---

## 4. Brand system (the non-negotiables)

Pulled from the existing `apps/marketing-site` (`src/styles.css`). The ordering app must look like a
sibling of the marketing site.

### 4.1 Color palette
**Base/background**
- Butter (primary bg): `#FFE9D2`
- Cream (secondary bg): `#FFF8E8`
- Paper (pale-pink section bg): `#FFF1F5`
- Milk (cards/surfaces): `#FFFFFF`

**Brand / CTA**
- Pink (primary brand + primary CTA): `#E91E63` (dark `#B91751`, soft `#FFD1DE`)
- Mint (secondary): `#9CD9B0` (dark `#4FA77C`, soft `#C8EFD9`)
- Orange (energetic accent): `#FF6B6B`
- Lemon (highlight/secondary button): `#FFD24C`

**Text (ink)**
- Ink (primary text): `#2A1722`
- Ink-2 (secondary): `rgba(42,23,34,.68)`
- Ink-3 (tertiary): `rgba(42,23,34,.45)`

**Extra accents for variety:** Peach `#FFB6B6`, Sky `#9CD9F0`, Grape `#B58BD6`.

> Usage: Butter for big backgrounds; Milk cards with **2.5px ink border + `0 5px 0 var(--ink)` bottom
> shadow**; Pink/Mint/Orange for primary CTAs; Lemon for secondary. Tint product-photo backgrounds with
> soft pastels (pink-soft, peach, mint-soft, lemon, sky).

### 4.2 Typography (Google Fonts)
- **Brand wordmark:** `Bagel Fat One` — "Example" in mint-d `#4FA77C`, "Kitchen" in pink `#E91E63`.
- **Display / headings:** `Caprasimo`.
- **Body / UI / buttons:** `DM Sans` (400/500/700/800).
- **Eyebrow / metadata labels:** `Geist Mono` (uppercase, ~11px, 0.18em tracking, 500).
- **Type scale (fluid):** Hero `clamp(54px,8.5vw,132px)`/lh .95; Mega `clamp(42px,6vw,96px)`; Large
  `clamp(34px,4.4vw,64px)`; Med `clamp(24px,2.4vw,36px)`; Body 16px/1.55; Lead `clamp(17px,1.5vw,20px)`.

### 4.3 Shape, border & shadow (the signature "chunky/bouncy" look)
- **Pill buttons:** `border-radius: 999px`, **2.5px solid ink border**, bold DM Sans 15px.
- **Cards/sections:** `border-radius: 28px` (large frames 36–48px), 2.5px ink border.
- **Bouncy drop shadow:** `0 5px 0 var(--ink)` on buttons/cards → tactile "press" feel.
  - Button hover: `translateY(2px)` + shadow `0 3px 0`; active: `translateY(5px)` + shadow gone.
- **Soft shadows** where subtle depth is needed: `0 4px 14px rgba(42,23,34,.08)`; hero `0 18px 40px -12px rgba(42,23,34,.20)`.
- **Playful decoration:** scattered color dots/pills (rotated, absolute), organic SVG blobs behind hero imagery, slight card rotation (−1.5° to 1.5°), tasteful emoji (🍓🍦🧋✨).

### 4.4 Voice & tone
Casual, fun, confident, experiential, a little irreverent. Second person ("you"). Emphasize the *show*
and the *vibe*, honesty on price ("real prices, no hidden fees"). Example lines to echo:
- "You only **ROLL** once." · "Pick your **vibe** today." · "Order from your phone. Skip the line."
- Playful item names: Mango Tango, Strawberry Example, Taro Snow.

### 4.5 Imagery
Bright food photography of rolled ice cream / boba / smoothies on soft pastel tinted backgrounds, framed
in white cards with ink border + bouncy shadow, slight rotation. Logo/favicon: rounded-square
pink→lime gradient badge with two white "rolls." Placeholder assets: `apps/marketing-site/src/public/signatures/`.

---

## 5. Information architecture (sitemap)

```
order-web
├─ Menu home (landing)               ← default entry; store status, pickup/ASAP, categories
│  ├─ Category sections (scroll)      ← Rolled Ice Cream · Bubble Tea · Smoothies · Specials
│  └─ Featured / Order Again rail
├─ Item builder (per item)           ← modal/full-screen customization
├─ Cart                              ← sticky bar → full cart
├─ Checkout                          ← guest-first; pickup time, tip, loyalty, gift card, payment
│  └─ Payment (Clover hosted fields/wallet)
├─ Order confirmation & status       ← Received → Preparing → Ready
├─ Rewards (loyalty)                 ← balance, progress, rewards wallet, challenges
│  └─ Enroll (phone + OTP)           ← also inline at checkout
├─ Gift cards                        ← buy/send · redeem · check balance
└─ Account (light)                   ← phone identity, saved order, payment, history
```

## 6. Global UI patterns (mobile-first)

- **Sticky bottom cart bar** once cart has items: "View cart · 2 · $12.40" — pinned in thumb zone,
  padded above the iOS home indicator (~100–150px clearance).
- **Primary CTAs in the bottom third** (thumb zone: ~96% tap accuracy vs ~61% up top).
- **Bottom sheets** for quick single choices (size, sweetness); **full-screen builder** for multi-group
  customization (see §7.3).
- **Sticky horizontal category tabs** with scroll-spy (highlight current section; tap to jump).
- **Tap targets ≥44×44px** (≥24px is the WCAG floor; use 44 for comfort), ≥8px spacing.
- **Live running total** everywhere a choice changes price; **optimistic, instant** cart updates (never full reload).
- **Persist cart** to local storage — survive refresh/navigation (a top abandonment cause).

---

## 7. Screen-by-screen specs

### 7.1 Menu home (landing)
- **Single store → skip store selection.** Drop the user straight onto the menu. (Architecture must
  still allow a store switcher later — §14.)
- **Top bar:** Example Kitchen wordmark; a **Pickup/Delivery** segmented control (v1 = Pickup only, but
  design the 2-segment control); a **Now / Later** control next to it — default **ASAP** with inline
  ready-time ("Ready ~7:25pm"); "Later" opens a day+time picker (window: today + next ~6 days).
- **Store status badge:** "Open · closes 9pm" / "Closed · opens 11am." When closed, still allow browse +
  schedule; never dead-end.
- **Featured / "Order Again" rail** at top (returning users: last order in one tap; first-timers:
  Popular / Signatures).
- **Category nav** sticky below the bar.
- **Loyalty chip** in the header: signed-out → "Join & earn"; signed-in → points + nearest reward.

### 7.2 Menu browse
- **Category sections** stacked, each with a header; sticky tab bar scroll-spies them.
  Suggested categories: **Rolled Ice Cream · Bubble Tea · Smoothies · Seasonal/Specials.**
- **Item card:** photo (pastel-tinted), name (playful), short description, price, and **calories**
  (US menu-labeling norm; optional macros later). One tap opens the builder.
- **Search** (persistent icon) for power users.
- **Dietary filter chips** above the menu (e.g. Dairy-free, Vegan, Contains nuts) — for desserts,
  allergen clarity matters.
- **Sold-out / 86'd items:** do NOT hide — dim image, grey text, "Sold out" badge, disable tap.
  (Driven by Clover/KDS 86 state — §13.)

### 7.3 Item builder (the centerpiece screen)
**Full-screen on mobile** for multi-group items; bottom-sheet OK for trivial 1-choice add-ons.
Pattern per modifier group: clear header + rule signal ("Required" / "Pick up to 3"); correct control
type (single = radio rows; multi = checkboxes; countable = **quantity steppers**); **sensible defaults**
pre-selected so a valid order exists with zero taps. **Sticky footer** holds the live price + big
**"Add to cart · $X.XX"** button. **Inline validation:** keep Add disabled until required groups are
satisfied; on tap, auto-scroll to the first unmet required group (never an error page).

**Example modifier structures (design for this complexity):**

*Rolled Ice Cream*
- Base flavor — **Required, pick 1** (Vanilla, Chocolate, Matcha, Taro, Strawberry…)
- Mix-ins folded into the roll — Optional, pick up to 3 (Oreo, brownie, fresh fruit, mochi…)
- Toppings — Optional, multi, qty steppers (whipped cream, sprinkles, wafer, Pocky, fresh fruit…)
- Drizzle/sauce — Optional, pick up to 2 (chocolate, caramel, condensed milk, strawberry…)

*Bubble Tea / Boba*
- Flavor — **Required, pick 1** (Classic Milk Tea, Taro, Mango, Brown Sugar, Matcha Latte…)
- Size — **Required** (Regular / Large)
- Sweetness — **Required, pick 1** (0 / 25 / 50 / 75 / 100%)
- Ice — **Required, pick 1** (No ice / Less / Regular / Extra)
- Toppings — Optional, multi, +price each, qty steppers (tapioca pearls, popping boba, grass jelly, pudding, aloe…)

*Smoothie*
- Flavor — Required (Strawberry, Mango Tango, Mixed Berry…); Size — Required; Add-ins — Optional (protein, chia, boba…)

Edit-from-cart reopens this builder **pre-filled** with prior selections.

### 7.4 Cart
- **Full cart** reached from the sticky bar. Each line: item name, **chosen-modifiers summary line**,
  qty stepper, edit (reopens builder pre-filled), remove.
- **Contextual upsell** rail: "Add a drink?" / "A little something sweet?" — one dismissible row.
- **Available reward row** here if signed in (see §7.7).
- Show any **order minimum** gap inline.
- Primary CTA → Checkout (thumb zone).

### 7.5 Checkout
- **Guest checkout is first-class and default.** Never force account creation; offer "save my info"
  AFTER the order succeeds.
- **Minimum fields:** name, **phone** (for "order ready" SMS — and the loyalty hook, §7.7), pickup time
  (re-shown & editable, not hidden behind a tiny link), payment. Email optional. Aim ≤7 fields.
- **Pickup time** visible and editable here (ASAP w/ ETA, or scheduled).
- **Tip:** preset chips (No tip / 15 / 18 / 20% / Custom), nothing pre-highlighted high; never re-prompt.
- **Utensils / order notes:** small optional rows.
- **Loyalty inline (§7.7):** single phone field — "Enter your number to earn points on this order."
- **Gift card:** "Apply a gift card" → code entry or saved card; **support split tender** (gift balance +
  card for remainder) so partial balances aren't stranded.
- **Payment:** **Apple Pay / Google Pay above the fold** (big mobile conversion lift), card entry below.
  Card entry is **Clover's hosted/iframe payment element** (see §13) — design the surrounding layout to
  embed Clover's fields cleanly; we never render raw card inputs ourselves.

### 7.6 Order confirmation & status
- **Confirmation:** order #, itemized recap, **ready-time ETA**, store address + map link, "earned X
  points" (§7.7), SMS opt-in / add-to-wallet.
- **Live status:** **Received → Preparing → Ready for pickup** (driven by KDS state — §13). "Ready"
  triggers SMS/push. Use a friendly tracker (think Domino's tracker, in our brand style).

### 7.7 Loyalty (rewards)
- **Enrollment = phone-first, inside the order.** At checkout, one inline field + **SMS OTP** (no
  password). Entering the number **retro-credits the current order** so the first earn feels instant.
  Persistent "Join & earn" affordance in the header too. Target: enroll in <15 seconds.
- **Rewards wallet** (own tab): lead with the **nearest unlockable reward + a progress bar**
  ("130 pts — 120 to your free roll"), then the rewards list, then challenges/offers. Keep it to a single
  "what can I get now" answer — avoid threshold sprawl.
- **The earn moment:** on the confirmation screen, an **animated points counter** + "You earned 120
  points!"; mirror via SMS.
- **Redemption in cart/checkout:** surface eligible rewards as an "Apply reward" row against the current
  cart; one tap discounts the line + updates total live. **One reward per order** (state it).
- **Challenges/offers:** dismissible cards with progress + CTA ("Order today for 100 bonus pts").
  Keep gamification light.

### 7.8 Gift cards
- **Buy/send:** choose amount (+ optional design) → personal message → optional **scheduled delivery** →
  send via SMS/email. Recipient can add to account or show in store.
- **Redeem:** at checkout via code or saved card; **split tender** supported; one-tap **balance check**.
- **Reload** (later phase): top up an existing card; earns points.
- v1 minimum: **redeem at checkout + check balance.** Full gifting flow can be Phase 2 (§14) but design it now.

### 7.9 Account (light, phone-based)
- Phone identity; saved last order ("Order again"); saved payment (tokenized); order history; points;
  gift cards; SMS/notification prefs. No heavy "profile" — keep it minimal.

---

## 8. Key user flows (design these end-to-end)
1. **First-time guest order:** Menu → build item(s) → cart → guest checkout → Apple Pay → confirmation
   (+ inline "earn points? enter phone").
2. **Returning member reorder:** Header shows points → "Order Again" one-tap → cart (reward auto-surfaced)
   → checkout (recognized by phone) → earn animation.
3. **Loyalty enrollment at checkout:** phone → OTP → current order credited.
4. **Reward redemption:** eligible reward appears in cart → apply → discounted → checkout.
5. **Gift card purchase:** amount → message → schedule → send.
6. **Gift card redemption w/ split tender:** apply card → partial balance → pay remainder by card.

## 9. States & edge cases — design ALL of these
Empty cart · loading (skeleton screens matching final layout) · generic error + retry (never lose cart) ·
**store closed / outside hours** (browse + schedule, no dead-end) · **item sold out / 86'd** (dim + badge) ·
**payment failure** (inline retry + alternate method; recovers ~30%) · **OTP failed/expired** ·
no search results · **order minimum not met** · reward not eligible for current cart · gift-card balance
insufficient (→ split tender) · slow network (optimistic UI + skeletons) · long item names / long modifier
lists on small screens.

## 10. Component inventory & design tokens (design system)
**Token layers (Tailwind v4 `@theme` + CSS vars; team uses Next.js + Tailwind + shadcn/ui):**
- *Base* (raw brand values from §4) → *Semantic* (`--color-action`, `--color-surface`, `--color-border`,
  `--color-text`, `--radius`, spacing scale) → *Component* tokens. **No raw hex in components.**
- Single `--radius` drives the scale; default pill for buttons (`999px`), 28px for cards.

**Components (each with full states: default / hover / active / focus / disabled / loading / error / empty):**
Button (primary pink / secondary lemon / mint / ghost), Input + labeled field + inline error, Select/Radio
row, Checkbox row, **Quantity stepper**, Card (item card, info card), Modal + **Bottom sheet**, Sticky
cart bar, Category tab/chip, Filter chip, Badge ("Sold out", "Popular", rotated), **Progress bar** (rewards),
Toast/inline alert, Skeleton loaders, Segmented control (Pickup/Delivery, Now/Later), Tip selector,
Order-status tracker, Reward/offer card, Gift-card visual.

Document spacing, type scale, motion, and the chunky-border + bouncy-shadow recipe so every component is
consistent.

## 11. Accessibility (WCAG 2.2 AA) — legally urgent
Restaurants are the **#1 ADA-sued web sector** (*Robles v. Domino's* held ordering sites are covered;
accessibility overlays do NOT count and have been FTC-fined). Requirements:
- **No image-only/PDF menus** — real semantic HTML menu.
- Tap targets ≥24×24px (we use ≥44); focus indicator ≥2px at ≥3:1 contrast; **focus never hidden behind
  the sticky cart bar** (2.4.11).
- Programmatic labels for menu items, modifier groups, steppers, cart, status.
- **Trap + restore focus** in bottom sheets/modals.
- Form errors as **text + ARIA tied to the field**, not color alone; body text contrast ≥4.5:1.
- Verify the brand pink/mint on butter meet contrast — adjust shade or add ink text/borders where needed
  (the brand already pairs colors with dark ink text/borders, which helps).

## 12. Performance & motion
- Speed converts: protect LCP/INP/CLS. **Skeleton screens** for menu/cart; **optimistic UI** on add/qty.
- Menu photos: responsive `srcset`, WebP/AVIF, explicit dimensions (no layout shift).
- Motion: tasteful and fast (button "press", points counter, sheet slide). Respect
  `prefers-reduced-motion`. Don't let delight slow the flow.

## 13. Technical constraints the design MUST respect
- **Payment = Clover hosted payment fields / iframe + tokenization.** Card data never touches our
  servers (keeps PCI scope to SAQ-A). Design the checkout payment area to **embed Clover's element**;
  Apple/Google Pay sit above it. (Provider is abstracted behind a `PaymentService`; Clover is first — the
  design should not hard-assume Clover-specific UI beyond the hosted field.)
- **Order flow:** online orders are created in Clover and **flow into the existing KDS** — so order
  **status (Received/Preparing/Ready)** comes from KDS/Clover state, not a separate system. Design status
  around those discrete states.
- **86'd / sold-out** comes from Clover/KDS sync — the menu must render a sold-out state per item.
- **Loyalty is phone-number based** (self-built CRM). Design enrollment/identity around a phone number +
  OTP, not email/password.
- **Gift cards** via a provider behind a `GiftCardService` (Clover native first) — design supports code
  entry, saved card, **split tender**, balance check.
- **Stack:** Next.js + Tailwind v4 + shadcn/ui. Favor shadcn-compatible component structures.
- **Multi-location-ready:** v1 is one store, but keep a store concept in the layout (a future store
  switcher / per-store hours, menu availability, pricing) so adding stores later is additive.

## 14. Build phasing (design the whole now; build in order)
- **Phase 1 (build first):** Menu home → browse → item builder → cart → **guest checkout + Clover
  payment** → confirmation + KDS-driven status. *(Loyalty + gift-card touchpoints in checkout designed
  now, wired in Phase 2/3.)*
- **Phase 2:** Gift cards (redeem + balance; then full gifting) behind `GiftCardService`.
- **Phase 3:** Loyalty — enrollment, rewards wallet, earn/redeem.
- **Phase 4 (later):** delivery, multi-location store switcher, reloads, challenges.

Design all phases as one cohesive system now (the user's explicit ask: plan up front, avoid rework).

## 15. Deliverables expected from the designer
1. **Mobile-first (375px) screens** for every screen in §7, each with the states in §9.
2. **Tablet/desktop** adaptations of the key screens (menu, builder, checkout).
3. A **component library** (§10) with tokens + all component states documented.
4. The **6 key flows** in §8 shown as connected screen sequences.
5. A short **design-system page** (colors, type, shape/shadow recipe, spacing, motion) derived from §4/§10.
6. Light/“default” theme first; dark mode optional (this is a bright, light brand — not required for v1).

## 16. References / inspiration (best-in-class, researched)
- **Ordering & customization:** Chipotle, Sweetgreen, Cava (custom-build bowls → analogous to our
  roll/boba builders), Shake Shack, Starbucks (Order Again), Domino's (status tracker).
- **Loyalty:** Starbucks Rewards (but avoid its threshold sprawl), Chipotle Rewards (phone-first enroll,
  consolidated rewards wallet), Dunkin' (challenges), Cava (light tiers); Sweetgreen *dropped* tiers for
  flat points — keep gamification simple.
- **Gift cards:** Starbucks Gift (design → amount → message → schedule → send; split tender).
- **Conversion/mobile/a11y:** Baymard checkout research, NN/g (bottom sheets, thumb zone), WCAG 2.2,
  ADA restaurant-lawsuit guidance, shadcn/ui theming.

> Reminder: a prior external online-ordering prototype repo leaked live Clover credentials — do **not**
> reuse its code/assets without rotation. This brief + the suite's own architecture supersede it.
