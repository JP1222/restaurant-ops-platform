import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  changeAccountPassword,
  createPasswordSetupToken,
  hashPassword,
  setPasswordWithToken,
  verifyAdminPassword,
  type AuthRedis,
} from "../../src/server/index.js";
import { startAuthItContext, type AuthItContext } from "./fixture.js";

// Minimal in-memory AuthRedis. The token mechanic (set/get/del) is trivial; the
// integration value here is the real argon2 hash/verify round-trip against the
// db-auth Postgres, which only a real DB exercises.
function memoryRedis(): AuthRedis {
  const store = new Map<string, string>();
  return {
    get: async (key) => store.get(key) ?? null,
    set: async (key, value) => {
      store.set(key, value);
      return "OK";
    },
    del: async (key) => (store.delete(key) ? 1 : 0),
    ttl: async () => -1,
    incr: async (key) => {
      const next = Number(store.get(key) ?? "0") + 1;
      store.set(key, String(next));
      return next;
    },
    expire: async () => 1,
  };
}

function stubHibpClean() {
  // Range response that never matches a real suffix → "not breached".
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("0000000000000000000000000000000000A:1", { status: 200 })),
  );
}

// Reads the single backfill UPDATE from the committed db-auth migration (F5):
// the test replays the REAL statement, so it can't drift from the migration.
const MIGRATION_SQL_PATH = fileURLToPath(
  new URL(
    "../../../db-auth/prisma/migrations/20260613_web_admin_password_set_at/migration.sql",
    import.meta.url,
  ),
);

function readBackfillStatement(): string {
  const sql = readFileSync(MIGRATION_SQL_PATH, "utf8");
  const statements = sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  const backfill = statements.find((statement) => /^UPDATE\b/i.test(statement));
  if (!backfill) {
    throw new Error(`No backfill UPDATE statement found in ${MIGRATION_SQL_PATH}`);
  }
  return backfill;
}

describe("password lifecycle integration (real db-auth Postgres)", () => {
  let ctx: AuthItContext;

  beforeAll(async () => {
    ctx = await startAuthItContext();
  });

  afterAll(async () => {
    await ctx?.stop();
  });

  beforeEach(async () => {
    await ctx.truncate();
    stubHibpClean();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Mirrors the kds-api placeholder create path (admin-user-service.createAdminUser):
  // a direct prisma.create with NO passwordSetAt, so the column stays NULL —
  // i.e. the account has no usable password until a setup link is redeemed.
  async function seedOwner(password: string) {
    return ctx.prisma.webAdminAccount.create({
      data: { username: "owner", displayName: "Owner", passwordHash: await hashPassword(password) },
    });
  }

  // Reads only the lifecycle marker, freshly, from the DB.
  async function passwordSetAtFor(accountId: string) {
    const row = await ctx.prisma.webAdminAccount.findUnique({
      where: { id: accountId },
      select: { passwordSetAt: true },
    });
    return row?.passwordSetAt ?? null;
  }

  it("changeAccountPassword rejects a wrong current password, then sets a new one", async () => {
    const account = await seedOwner("current-passphrase-2026");

    // Placeholder create path leaves the lifecycle marker NULL (no usable password yet).
    expect(await passwordSetAtFor(account.id)).toBeNull();

    const wrong = await changeAccountPassword(ctx.prisma, {
      accountId: account.id,
      currentPassword: "not-the-password",
      newPassword: "a-fresh-long-passphrase-xyz",
    });
    expect(wrong).toEqual({ ok: false, reason: "incorrect_current", message: expect.any(String) });

    // A REJECTED change must not stamp the marker.
    expect(await passwordSetAtFor(account.id)).toBeNull();

    const ok = await changeAccountPassword(ctx.prisma, {
      accountId: account.id,
      currentPassword: "current-passphrase-2026",
      newPassword: "a-fresh-long-passphrase-xyz",
    });
    expect(ok.ok).toBe(true);

    // A successful self-change stamps passwordSetAt non-null (now a usable password).
    expect(await passwordSetAtFor(account.id)).toBeInstanceOf(Date);

    // Verifies against what was actually persisted (real argon2 in Postgres).
    expect(await verifyAdminPassword(ctx.prisma, "owner", "a-fresh-long-passphrase-xyz")).not.toBeNull();
    expect(await verifyAdminPassword(ctx.prisma, "owner", "current-passphrase-2026")).toBeNull();
  });

  it("changeAccountPassword rejects a too-short new password", async () => {
    const account = await seedOwner("current-passphrase-2026");
    const result = await changeAccountPassword(ctx.prisma, {
      accountId: account.id,
      currentPassword: "current-passphrase-2026",
      newPassword: "short",
    });
    expect(result).toEqual({ ok: false, reason: "too_short", message: expect.any(String) });
  });

  it("setPasswordWithToken sets a chosen password and the token is single-use", async () => {
    const account = await seedOwner("placeholder-passphrase-2026");
    const redis = memoryRedis();
    const token = await createPasswordSetupToken(redis, account.id, "invite");

    // Never-redeemed invite: the marker is NULL until the link is redeemed.
    expect(await passwordSetAtFor(account.id)).toBeNull();

    const first = await setPasswordWithToken(ctx.prisma, redis, {
      token,
      newPassword: "chosen-long-passphrase-2026",
    });
    expect(first.ok).toBe(true);
    expect(await verifyAdminPassword(ctx.prisma, "owner", "chosen-long-passphrase-2026")).not.toBeNull();

    // Redeeming the invite stamps passwordSetAt non-null (now a usable password).
    expect(await passwordSetAtFor(account.id)).toBeInstanceOf(Date);

    const second = await setPasswordWithToken(ctx.prisma, redis, {
      token,
      newPassword: "another-long-passphrase-2026",
    });
    expect(second).toEqual({ ok: false, reason: "token_invalid", message: expect.any(String) });
  });

  it("setPasswordWithToken does not burn the token on a weak password (retryable)", async () => {
    const account = await seedOwner("placeholder-passphrase-2026");
    const redis = memoryRedis();
    const token = await createPasswordSetupToken(redis, account.id, "reset");

    const weak = await setPasswordWithToken(ctx.prisma, redis, { token, newPassword: "short" });
    expect(weak.ok).toBe(false);

    // A rejected (weak) set must not stamp the marker.
    expect(await passwordSetAtFor(account.id)).toBeNull();

    const ok = await setPasswordWithToken(ctx.prisma, redis, {
      token,
      newPassword: "strong-enough-passphrase-2026",
    });
    expect(ok.ok).toBe(true);
    expect(await passwordSetAtFor(account.id)).toBeInstanceOf(Date);
  });

  // The migration backfill (20260613_web_admin_password_set_at) seeds
  // passwordSetAt = updatedAt for pre-existing rows so live admins are NOT
  // falsely treated as placeholder-only, and is idempotent (WHERE ... IS NULL)
  // so a re-run never clobbers a real password-set value. We can't time-travel
  // the deployed migration over a row that didn't exist yet, so we replay the
  // exact backfill statement to prove its semantics on representative rows.
  //
  // F5 (review): read the statement from the committed migration.sql rather than
  // hand-copying it here, so an edit to the migration can't silently drift from
  // what this test claims to verify. We strip comment lines and extract the lone
  // UPDATE (backfill) statement; the ALTER TABLE is irrelevant to replay.
  const BACKFILL_SQL = readBackfillStatement();

  it("migration backfill stamps a NULL (pre-existing) row from updatedAt", async () => {
    // A row created without passwordSetAt models a pre-migration admin row.
    const account = await seedOwner("legacy-passphrase-2026");
    expect(await passwordSetAtFor(account.id)).toBeNull();

    await ctx.prisma.$executeRawUnsafe(BACKFILL_SQL);

    const after = await ctx.prisma.webAdminAccount.findUnique({
      where: { id: account.id },
      select: { passwordSetAt: true, updatedAt: true },
    });
    expect(after?.passwordSetAt).toBeInstanceOf(Date);
    // Backfilled value equals the row's updatedAt (the best-available proxy).
    expect(after?.passwordSetAt?.getTime()).toBe(after?.updatedAt.getTime());
  });

  it("migration backfill is idempotent: it never clobbers an already-set marker", async () => {
    const account = await seedOwner("legacy-passphrase-2026");
    // Establish a real password (stamps a definite passwordSetAt).
    const ok = await changeAccountPassword(ctx.prisma, {
      accountId: account.id,
      currentPassword: "legacy-passphrase-2026",
      newPassword: "real-chosen-passphrase-2026",
    });
    expect(ok.ok).toBe(true);
    const before = await passwordSetAtFor(account.id);
    expect(before).toBeInstanceOf(Date);

    // Re-running the backfill must skip this row (WHERE passwordSetAt IS NULL).
    await ctx.prisma.$executeRawUnsafe(BACKFILL_SQL);

    expect((await passwordSetAtFor(account.id))?.getTime()).toBe(before?.getTime());
  });
});
