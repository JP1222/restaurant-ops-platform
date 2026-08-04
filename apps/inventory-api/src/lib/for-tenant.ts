import type { Prisma, PrismaClient } from "@rop/db-inventory";

/**
 * The single tenant-scoping chokepoint (ADR-0818 / #902 Phase 1; see
 * docs/architecture/multi-tenant-greenfield-target.md §5). Opens a transaction,
 * sets the `app.tenant_id` GUC for that transaction via `SET LOCAL`, and runs the
 * callback on the transaction's client — so Postgres Row-Level Security keys every
 * read/write on the resolved tenant.
 *
 * Invariants:
 * - **Fail-closed:** `tenantId` is validated non-empty/non-blank and THROWS
 *   otherwise — it must never silently scope to `''` or `DEFAULT_TENANT_ID`, which
 *   would read tenant #1's rows. Only a resolved, authenticated tenant reaches here.
 * - **Transaction-local GUC:** `set_config('app.tenant_id', $1, true)` — the
 *   `true` makes it `SET LOCAL` (rolled back at txn end), and the value is a BOUND
 *   parameter, never string-concatenated.
 * - **Direct-connect today:** inventory-api connects straight to Postgres (no
 *   PgBouncer), so the txn-local GUC binds to the backend running it. If a
 *   transaction pooler is ever introduced it MUST be transaction-pooling and this
 *   logic MUST stay inside the txn.
 *
 * Lands ahead of its consumers (Phase-1 staging): until RLS is enabled on the
 * inventory tables and the store mutations are routed through `.run()`, the
 * `SET LOCAL` is an inert GUC nothing reads — exactly like the nullable `tenant_id`
 * columns shipped before it. The store-mutation refactor adopts it incrementally.
 */
export function forTenant(prisma: PrismaClient, tenantId: string) {
  const id = tenantId?.trim();
  if (!id) {
    throw new Error("forTenant: a non-empty tenantId is required (fail-closed)");
  }
  return {
    run<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
      return prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${id}, true)`;
        return fn(tx);
      });
    }
  };
}
