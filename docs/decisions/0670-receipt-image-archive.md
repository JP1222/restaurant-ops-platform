# ADR-0670: Archive scanned receipt images in R2, served via inventory-api

- **Status**: Accepted
- **Date**: 2026-06-15
- **Deciders**: @example-org

## Context

The AI invoice scan ([ADR-0538](0538-ai-invoice-scan-for-receiving-via-deepseek-vision.md), vision on Gemini) runs the receipt image through OCR, pre-fills the receive intake, and then **discards the image**. Only the downstream writes persist — `inventory_stock_movements`, learned `inventory_item_aliases`, cost history. There is no durable record of the original invoice, nor a single place that ties "what the operator confirmed" to "the paper it came from." The owner wants to look back at *which day's* delivery and see both the original photo and the logged quantities/costs (audit, vendor disputes, re-checking a price).

The image is therefore a genuinely new entity, not a flag to flip on. Receipts differ from the existing item photos (`InventoryItemImage`, raw bytes in Postgres): item photos are **bounded** (one per catalog item, replaced in place), whereas receipts are **append-only and unbounded** over time — every confirmed delivery adds one.

## Decision

- **New table `inventory_receipt_scans`** (`packages/db-inventory`): one row per *confirmed ad-hoc receive that carried a scanned image* — vendor, invoice date, actor, a jsonb snapshot of the confirmed lines, and the object key. Keyed unique on `(location_id, ref)` where `ref` is the **same idempotency anchor** the receive's stock movements use (`adhoc:<ref>:<i>`), so the archive row and the movements it explains share one key and a replay no-ops both.
- **Image bytes live in Cloudflare R2** (object storage); Postgres stores only the object key. This is the suite's **first in-app S3 client** — `@aws-sdk/client-s3` in `inventory-api` (R2 is S3-compatible). Creds are app-runtime secrets at Infisical prod `/` ([ADR-0020](0020-adopt-infisical-for-runtime-secrets.md)): `R2_ENDPOINT` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `RECEIPT_R2_BUCKET`, all optional (unset → archiving is skipped, a receive still succeeds).
- **Best-effort archive.** The R2 upload happens *outside* the receive DB transaction (network I/O); `receiveAdHoc` writes the archive row *inside* its transaction using the returned key. A failed or unconfigured upload logs a structured warning and records the row with a `NULL` image key — a confirmed receive is never failed because its photo couldn't be stored. The R2 object key derives from `ref`, so a retried upload overwrites the same object instead of leaking a duplicate.
- **Read path:** `inventory-api` exposes `GET /api/inventory/receipts` (list, optional `from`/`to` day bounds) and `GET /api/inventory/receipts/:id/image` (streams bytes from R2, location-scoped). `backoffice-web` proxies both through its BFF (Iron Law 4 — the browser can't reach inventory-api); the Receiving tab renders a date-grouped "history" view with thumbnails. Receipts are **not** folded into the hot `/api/inventory` dataset — that's polled every 60s and receipts grow unbounded.

## Consequences

- **Easy:** a durable, auditable receipt archive tied to the stock log; image growth never bloats Postgres or the nightly PG→R2 backup dump ([backup](../../OPERATIONS.md)); the by-date history answers the owner's "show me Tuesday's Sam's delivery" directly.
- **New to live with:** a second R2 credential — bucket-scoped to `rop-receipts`, Object Read & Write, rotated independently of the backup token (see Alternatives below). The receipts bucket is object storage already, but is **not** age-encrypted like the DB backups — acceptable, as receipt images are not secrets. A receive transaction that fails *after* a successful upload can orphan an R2 object (rare; the deterministic key bounds it to one-per-ref; a sweeper can be added if it ever matters).
- **Boundary:** stays inside Iron Law 5 — the write originates in `inventory-api` (the inventory DB's owner) at receive time, not in backoffice's stateless OCR route.

## Alternatives considered

- **Postgres `bytea` (like `InventoryItemImage`).** Rejected: receipts are append-only and unbounded, so bytes-in-PG grows without bound and inflates every nightly `pg_dump`. Object storage is the right home for unbounded blobs.
- **Presigned R2 URLs handed to the browser.** Rejected for v1: proxying bytes through inventory-api keeps the bucket private and matches the existing item-photo serving pattern. Revisit if serving volume ever makes the proxy hop costly.
- **Persist at scan time (backoffice `receipt-parse`).** Rejected: that route is stateless OCR and backoffice cannot write inventory's DB (Iron Law 5). The archive belongs with the receive write, in inventory-api.
- **Reuse the backup R2 token/bucket.** Rejected: the backup token is bucket-scoped to `rop-backups`, and giving a web-serving app read/delete over the age-encrypted DB backups widens the disaster-recovery blast radius. The Cloudflare account/endpoint is shared; only a new, narrowly-scoped token + its own bucket are added.
- **Do nothing.** Rejected: the owner explicitly wants the original image + the logged data retrievable by date; today both the image and any per-receive record are discarded.
