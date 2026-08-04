// Dev-only: (re)set a FIXED, known local admin password so backoffice / kds-web
// login is repeatable — no one-time-password to copy. Writes db-auth directly
// (idempotent upsert), so it needs no running stack. One admin row logs into
// BOTH backoffice and kds-web.
//
// Lives under apps/kds-api (the auth-bearing backend, where @rop/db-auth
// + @rop/auth + tsx all resolve) and is run by scripts/seed-admin.sh via
// `make admin`. Not part of the kds-api build/lint (scripts/ is outside src/).
//
// HARD GUARD: refuses to run with NODE_ENV=production — a known, committed
// password must never reach a real database (that would be a backdoor).
import { hashPassword } from "@rop/auth/server";
import { createPrismaClient } from "@rop/db-auth";

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    console.error("dev-admin: refusing to set a fixed password with NODE_ENV=production.");
    process.exit(1);
  }

  const username = process.env.DEV_ADMIN_USERNAME ?? "admin";
  const displayName = process.env.DEV_ADMIN_DISPLAY_NAME ?? "Admin";
  const password = process.env.DEV_ADMIN_PASSWORD;
  if (!password) {
    console.error(
      "dev-admin: DEV_ADMIN_PASSWORD is required (set in scripts/dev-defaults.sh).",
    );
    process.exit(1);
  }

  const prisma = createPrismaClient();
  try {
    const passwordHash = await hashPassword(password);
    // Stamp passwordSetAt: the dev admin has a real, usable password, so the
    // lockout guard must not classify it as password-less (which would block
    // removing its only passkey). Mirrors bootstrapAdminAccount in packages/auth.
    const now = new Date();
    const account = await prisma.webAdminAccount.upsert({
      where: { username },
      create: { username, displayName, passwordHash, passwordSetAt: now },
      update: { passwordHash, passwordSetAt: now },
    });
    const url = process.env.BACKOFFICE_BASE_URL ?? "http://localhost:3001";
    console.log(`✓ local admin ready — username: ${account.username}   password: ${password}`);
    console.log(`  log in at ${url}  (one admin works for both backoffice and kds-web)`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("dev-admin failed:", error);
  process.exit(1);
});
