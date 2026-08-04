import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startKdsItContext, type KdsItContext } from "./fixture.js";

// Proves the kds-specific mechanics no other suite covers: db-kds and db-auth
// share ONE physical Postgres (ADR-0015), and the Redis helper yields a working
// instance. The full HTTP app boot is a documented follow-up.
describe("kds-api integration (shared db-kds + db-auth Postgres, real Redis)", () => {
  let ctx: KdsItContext;

  beforeAll(async () => {
    ctx = await startKdsItContext();
  });

  afterAll(async () => {
    await ctx?.stop();
  });

  it("migrates db-kds AND db-auth into one physical database (ADR-0015)", async () => {
    // Queried through the db-kds client: a db-kds table and a db-auth table both
    // live in the same database — the two Prisma packages, one Postgres.
    const tables = await ctx.prismaKds.$queryRawUnsafe<Array<{ table_name: string }>>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN ('kds_tickets', 'web_admin_accounts')
       ORDER BY table_name`,
    );
    expect(tables.map((t) => t.table_name)).toEqual(["kds_tickets", "web_admin_accounts"]);
  });

  it("both Prisma clients operate against the shared connection", async () => {
    // db-auth client writes + reads its own table...
    await ctx.prismaAuth.webAdminAccount.create({
      data: { username: "kds-owner", displayName: "Owner", passwordHash: "argon2-placeholder" },
    });
    expect(await ctx.prismaAuth.webAdminAccount.count()).toBe(1);

    // ...while the db-kds client reads its own table on the same database url.
    const kds = await ctx.prismaKds.$queryRawUnsafe<Array<{ n: number }>>(
      "SELECT count(*)::int AS n FROM kds_tickets",
    );
    expect(kds[0]?.n).toBe(0);
  });

  it("the Redis helper yields a working Redis (SET/GET round-trip)", async () => {
    await ctx.redis.set("kds:probe", "pong");
    expect(await ctx.redis.get("kds:probe")).toBe("pong");
  });
});
