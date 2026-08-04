# Database Agents (Inventory)

`packages/db-inventory` owns the Prisma schema, migration history, and database client for the **inventory** domain. It is a sibling of `packages/db-kds`, not a replacement: per Iron Law 1 each app owns its own Postgres database, and inventory picks its own here (`INVENTORY_DATABASE_URL`).

The generated Prisma client is emitted to a package-local path (`generated/client`, gitignored) and re-exported from `src/index.ts`, so it never collides with db-kds's client in the shared `node_modules/@prisma/client` location.

Use these checks when relevant:

- `pnpm --filter @rop/db-inventory generate`
- `pnpm --filter @rop/db-inventory build`
- `pnpm --filter @rop/db-inventory migrate` # dev migration
- `pnpm --filter @rop/db-inventory seed`     # load the demo dataset

Do:

- Keep migrations explicit and reviewable; document compatibility + rollback when changing existing shapes.
- Mirror the `@rop/contracts` `InventoryDataset` DTO shape; coordinate schema changes with contracts and `apps/inventory-api`.
- Preserve the inventory database as the durable source of truth for stock, waste, counts, POs, vendors, and items.
- `inventory_item_aliases` is the **learned vendor-alias** memory for the AI invoice scanner (ADR-0586, extends [ADR-0538](../../docs/decisions/0538-ai-invoice-scan-for-receiving-via-deepseek-vision.md)): a confirmed receive upserts `(vendor, normalized) → item_id` so the next invoice auto-matches that vendor's wording to the one canonical item (never a duplicate SKU per vendor). The match key uses `normalizeAlias` from `@rop/contracts` — keep the write side (inventory-api) and read side (both web matchers) on that one function so the key never drifts. Brand-level (shared across stores), so not location-scoped.
- Store-level operational tables (`inventory_purchase_orders`, `inventory_po_lines`, `inventory_count_records`, `inventory_waste_entries`, `inventory_activity_entries`, `inventory_employees`) carry a `location_id` (default `'default-location'`) for multi-location scoping ([ADR-0018](../../docs/decisions/0018-multi-location-architecture.md)); the inventory-api filters reads/writes by it. Per-store **stock state** (`on_hand`, par levels, `last_counted`, `flagged_86`) lives in `inventory_item_state` keyed by `(location_id, item_id)`; the `InventoryItem` columns are retained as the brand catalog defaults + non-destructive fallback for a location with no state row yet. Brand-level catalog tables (items, recipes, vendors, categories, waste reasons, settings, metrics) stay shared, so the split does **not** touch the `InventoryDataset` contract — the API merges catalog + state back into the same `InventoryItem` DTO. Not yet done (follow-up): per-store recipe price overrides (those would touch the contract DTO).
- Keep `InventoryEmployee` PINs secret: store only the argon2 `pin_hash` and the keyed `pin_lookup` HMAC (computed via `@rop/auth/crew`), never plaintext, and never log them. `pin_lookup` is unique, which enforces one PIN per employee. The seed reads `CREW_PIN_PEPPER`; this table is crew-auth data and is intentionally not part of the `InventoryDataset` contract.

Do not:

- Cross-import this client into another app's service (Iron Law 1). Only `apps/inventory-api` consumes it.
- Store sales/COGS aggregates as the source of truth here — those belong to `apps/analytics-api` (Iron Law 5). The `InventoryMetrics` row is a pre-integration placeholder.
- Add columns for client-only presentation state.
