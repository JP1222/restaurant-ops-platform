# ADR-0538: AI invoice scan for receiving via DeepSeek vision

- **Status**: Accepted — built + deployed; **vision provider corrected to Google Gemini 2026-06-06** (DeepSeek has no image API — see correction below)
- **Date**: 2026-06-04
- **Deciders**: @example-org

> **Correction (2026-06-06).** The premise below — "DeepSeek V4 is natively
> multimodal" — is **false**. DeepSeek's API (`deepseek-v4-pro`/`flash`,
> `deepseek-chat`, `deepseek-reasoner`) exposes **no image-capable model**, and the
> `@ai-sdk/deepseek` provider drops image parts ("user message part type: file is not
> supported"), so a scan reached the model as text-only and returned **zero lines**.
> The invoice-scan **vision step now runs on Google Gemini** (`lib/ai/vision-provider.ts`,
> setting `ai.vision_model_id` default `gemini-flash-latest`, key `ai.vision_api_key`).
> DeepSeek stays the text chat brain. Everything else here (D1–D3, the deterministic
> description→SKU match, the BFF / Iron-Law boundary) is unchanged — only the vision
> model swapped.

## Context

Backoffice inventory now has a working catalog (items, vendors, POs). The next
data-entry pain is **receiving**: when a delivery arrives, someone reads the vendor's
paper invoice and types every line (product, qty, price). A mid-size order is 20-40
lines — the single most keystroke-heavy, error-prone inventory task.

Two gaps today:

1. **Backoffice has no receive UI.** The receive *API* exists
   (`POST /api/inventory/pos/:id/receive`, idempotent via the stock-movement ledger)
   and the floor app (crew-web) uses it, but `backoffice-web`'s Receiving tab only
   lists POs — the "Receive" button has no handler and there is no receive hook. So
   "manual receiving on backoffice" must be built regardless.
2. **Receiving is strictly PO-based.** A store just standing up its inventory (empty
   catalog, no POs) has a stack of invoices and nothing to receive against.

The owner wants: keep manual entry, **and** add an **AI invoice-scan** that
photographs the invoice and auto-fills the receive form for fast entry.

The AI stack is DeepSeek via the Vercel `ai` SDK, key in an encrypted `app_setting`
row (`ai.deepseek_api_key`), all calls through a backoffice BFF (Iron Law: the
browser never calls the provider). As of 2026-06 **DeepSeek V4 (`deepseek-v4-pro/
flash`) is natively multimodal** — image+text, tuned for form/layout extraction — so
the existing provider + key can do invoice OCR without a second AI vendor.

## Decision

Build AI-assisted receiving in three layers, reusing the existing DeepSeek provider
and the existing idempotent stock-movement ledger.

### D1 — Manual + AI share one surface

Not two UIs. A single **Receive intake** sheet on the Receiving tab holds an editable
line table (`description / qty / unit / unit cost / matched item`). Fill it by hand,
or pre-fill it with a scan. AI is a "quick fill" button on that table, not a separate
flow; review / edit / commit are shared. This is what makes "保留手动 + 加 AI"
collapse to one surface.

### D2 — Support both PO-bound and ad-hoc receiving

- **PO-bound**: receive against a selected open PO → match lines to the PO's expected
  items → commit via the existing `POST /pos/:id/receive`.
- **Ad-hoc (no PO)**: a new `POST /api/inventory/receive` records the receipt
  directly. Unmatched descriptions can **create a catalog item inline** (reusing
  `createItem`), so an empty store bootstraps its catalog *from* its invoices.

Both go through the same ledger + idempotency key `(location, reason, source_ref,
item)`; ad-hoc uses a generated `source_ref` (`adhoc:<uuid>`), so a double-submit is
a no-op exactly like PO receive.

### D3 — Vision extraction is a server-side BFF route returning validated JSON

`POST /api/inventory/receipt-parse` (backoffice BFF) takes a base64 image, calls
DeepSeek vision via the existing provider with structured output against a zod schema,
and returns `InventoryReceiptParseResult` (`vendor?`, `invoice_date?`, `lines[]`).
The key stays server-side. A new `ai.vision_model_id` setting (default
`deepseek-v4-pro`) lets the operator switch the vision model without a redeploy,
mirroring `ai.model_id`.

Extraction returns **raw descriptions**, never catalog ids. Mapping description →
catalog item is a separate, deterministic step (normalized name/sku fuzzy match)
shown in the review table — the model is never trusted to invent a SKU. Unmatched
lines are flagged for manual pick or inline create.

**Floor reuse (crew-web).** The same scan flow ships on the Floor app, but `crew-web`
is intentionally lean and has no AI provider. Rather than duplicate the DeepSeek key
into a second app, crew-web's `POST /api/inventory/scan` BFF route **proxies the image
to this backoffice route server-to-server**, authenticated with a shared
`INTERNAL_AI_TOKEN` bearer (an alternative to a backoffice session on this one route;
the kill-switch + rate-limit + fail-closed 503 still apply). Backoffice stays the
single AI surface; crew-web forwards and returns the validated parse unchanged, then
runs the same deterministic client-side matching. When unconfigured, the Floor scan
fails closed in production and falls back to a live-catalog stub only in local dev.

### D4 — The model proposes, the human commits

The scan only *pre-fills* the table. Nothing writes to stock until the operator
reviews and confirms; per-line unmatched/low-confidence flags are shown. A
hallucinated qty or price cannot silently corrupt on-hand.

## Consequences

- **Easy**: fast receiving from a photo; an empty store bootstraps its catalog from
  invoices; manual receiving on backoffice finally exists; no second AI vendor/key.
- **Hard / new risks**:
  - Vision quality is unproven for *this* task — validate with a real-invoice smoke
    test before P3 ships; `ai.vision_model_id` is the escape hatch to a stronger
    model (Claude/GPT-4o) if DeepSeek underperforms.
  - Ad-hoc receive is a second write path to stock; it MUST reuse the same ledger +
    idempotency so it can't double-apply.
  - Inline item-create from a parsed line goes through `createItem` + a category
    (default bucket, operator-editable) — never write an item the catalog can't
    render.
  - Prod dependency: inert until `ai.deepseek_api_key` is set in prod and the model
    supports vision. The parse route fails closed (503) when unconfigured, like chat.
- **Cost**: each scan is one vision call; gate behind the existing `ai.kill_switch`
  and rate limit.

## Alternatives considered

- **Add a dedicated vision provider (Claude/GPT-4o) now.** Strongest extraction, but
  a second AI vendor + key + cost the owner chose to avoid ("先试现有 DeepSeek").
  Deferred to the `ai.vision_model_id` switch if quality is insufficient.
- **PO-bound only.** Smaller backend change, but useless for a store with invoices
  and no POs — the owner's current state. Rejected per "两者都要".
- **Trust the model to emit catalog SKUs directly.** Removes matching, but invites
  hallucinated/duplicate SKUs into the ledger. Rejected — extraction returns
  descriptions; matching is deterministic.
- **Do nothing / manual only.** Leaves the heaviest inventory task fully manual.
  Rejected — it is the headline request.
