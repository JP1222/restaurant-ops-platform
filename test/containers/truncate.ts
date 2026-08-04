/**
 * Wipe table data between tests while keeping the schema (and migration
 * bookkeeping) intact.
 *
 * Decoupled from any specific client: pass a `run` that executes raw SQL and
 * returns result rows. Both client shapes satisfy it —
 *   Prisma: `(sql) => prisma.$queryRawUnsafe(sql)`
 *   pg:     `(sql) => pool.query(sql).then((r) => r.rows)`
 * — so the same helper serves the Prisma apps and the raw-`pg` analytics app.
 */
export type SqlRunner = (sql: string) => Promise<Array<Record<string, unknown>>>;

export interface TruncateOptions {
  /** Schemas to wipe. Prisma apps use `["public"]`; analytics adds raw/mart/audit. */
  schemas?: string[];
  /** Tables (bare names) never to truncate — migration ledgers. */
  exclude?: string[];
}

const DEFAULT_EXCLUDE = ["_prisma_migrations", "schema_migrations"];

/** Quote a Postgres identifier, escaping embedded double-quotes. */
function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export async function truncateAll(run: SqlRunner, options: TruncateOptions = {}): Promise<void> {
  const schemas = options.schemas ?? ["public"];
  const exclude = new Set([...(options.exclude ?? []), ...DEFAULT_EXCLUDE]);

  const schemaList = schemas.map((s) => `'${s.replace(/'/g, "''")}'`).join(", ");
  const rows = await run(
    `SELECT schemaname, tablename FROM pg_tables WHERE schemaname IN (${schemaList})`,
  );

  const targets = rows
    .map((r) => ({ schema: String(r.schemaname), table: String(r.tablename) }))
    .filter((t) => !exclude.has(t.table))
    .map((t) => `${ident(t.schema)}.${ident(t.table)}`);

  if (targets.length === 0) return;
  await run(`TRUNCATE ${targets.join(", ")} RESTART IDENTITY CASCADE`);
}

/** Minimal structural shape of a Prisma client's raw-SQL escape hatches. */
export interface RawSqlCapable {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

/**
 * Adapt a Prisma client to a {@link SqlRunner}. Prisma splits raw SQL into
 * `$queryRawUnsafe` (returns rows) and `$executeRawUnsafe` (returns a count), so
 * route SELECTs to the former and everything else (TRUNCATE) to the latter.
 * Works for any of the generated clients (db-kds / db-auth / db-inventory) since
 * it only needs the structural shape above.
 */
export function prismaSqlRunner(prisma: RawSqlCapable): SqlRunner {
  return async (sql) => {
    if (/^\s*select/i.test(sql)) {
      return prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(sql);
    }
    await prisma.$executeRawUnsafe(sql);
    return [];
  };
}
