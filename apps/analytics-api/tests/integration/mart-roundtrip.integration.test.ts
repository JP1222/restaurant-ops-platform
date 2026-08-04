import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MIGRATION_VERSIONS, startAnalyticsItContext, type AnalyticsItContext } from "./fixture.js";

// Proves the third migration mechanic — analytics-api's home-grown raw-SQL
// runner (apps/analytics-api/src/migrate.ts), not Prisma — against a real
// Postgres, plus a write/read round-trip on the migrated schema.
describe("analytics-api integration (real Postgres, raw-SQL migrations)", () => {
  let ctx: AnalyticsItContext;

  beforeAll(async () => {
    ctx = await startAnalyticsItContext();
  });

  afterAll(async () => {
    await ctx?.stop();
  });

  it("applies every forward-only SQL migration and records it in the ledger", async () => {
    const { rows } = await ctx.pool.query<{ version: string }>(
      "SELECT version FROM audit.schema_migrations ORDER BY version",
    );
    expect(rows.map((r) => r.version)).toEqual(MIGRATION_VERSIONS);
  });

  it("is idempotent — re-running the runner applies nothing new", async () => {
    await ctx.migrate();
    const { rows } = await ctx.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit.schema_migrations",
    );
    expect(rows[0]?.n).toBe(MIGRATION_VERSIONS.length);
  });

  it("produces a usable schema — writes then reads a real audit row", async () => {
    await ctx.pool.query(
      `INSERT INTO audit.ai_query_log (actor, sql_text)
       VALUES ('it-actor', 'SELECT 1')`,
    );
    const inserted = await ctx.pool.query<{ actor: string; rejected: boolean }>(
      "SELECT actor, rejected FROM audit.ai_query_log",
    );
    expect(inserted.rows).toHaveLength(1);
    expect(inserted.rows[0]).toMatchObject({ actor: "it-actor", rejected: false });

    // truncate clears data across all data schemas but preserves the ledger.
    await ctx.truncate();
    const data = await ctx.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit.ai_query_log",
    );
    expect(data.rows[0]?.n).toBe(0);
    const ledger = await ctx.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit.schema_migrations",
    );
    expect(ledger.rows[0]?.n).toBe(MIGRATION_VERSIONS.length);
  });
});
