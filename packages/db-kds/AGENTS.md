# Database Agents

`packages/db-kds` owns Prisma schema, migration history, and database client helpers.

Use these checks when relevant:

- `pnpm --filter @rop/db-kds generate`
- `pnpm --filter @rop/db-kds build`
- `pnpm --filter @rop/db-kds lint`

Do:

- Keep migrations explicit and reviewable.
- Document compatibility assumptions when schema changes affect existing deployment data.
- Coordinate database shape changes with API services and tests.
- Preserve the server database as the durable source of truth.
- Treat `CloverMerchant` / `CloverOrder` as the GENERIC store-account / order tables, not Clover-only — they hold non-Clover sources (e.g. Deliverect) tagged by `provider`. See [ADR-0019](../../docs/decisions/0019-decouple-store-identity-from-clover.md); don't bake Clover-exclusive assumptions onto these names.

Do not:

- Change Prisma schema without considering migrations and rollback/fallback behavior.
- Store provider secrets or customer/order data in logs or docs.
- Add columns for client-only presentation state unless the backend owns that state.
