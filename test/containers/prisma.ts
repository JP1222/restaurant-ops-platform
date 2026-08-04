import { execFile } from "node:child_process";
import { promisify } from "node:util";

// execFile (not the shell `exec`) with a fixed argv — the only interpolated
// value is the typed `pkg` union (never user input); connection URLs are passed
// via env, not argv. No shell, no injection surface.
const runFile = promisify(execFile);

export type PrismaPackage = "db-kds" | "db-auth" | "db-inventory";

/** Which env var each Prisma package's datasource reads (see each prisma.config.ts). */
const ENV_VAR: Record<PrismaPackage, "DATABASE_URL" | "INVENTORY_DATABASE_URL"> = {
  "db-kds": "DATABASE_URL",
  "db-auth": "DATABASE_URL",
  "db-inventory": "INVENTORY_DATABASE_URL",
};

/** `pnpm --filter @rop/<pkg> <args...>` with extra env merged over process.env. */
async function runPnpm(pkg: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  await runFile("pnpm", ["--filter", `@rop/${pkg}`, ...args], {
    env: { ...process.env, ...env },
    timeout: 120_000,
  });
}

/**
 * Apply a Prisma package's committed migrations to an arbitrary database by
 * spawning `prisma migrate deploy` with the connection URL injected into the
 * child process env (the datasource reads it from `process.env` at runtime).
 *
 * Mirrors the production migrate path and the `migration-smoke` CI job exactly
 * — including the db-kds-then-db-auth ordering against one shared database
 * (ADR-0015) — so integration tests exercise the real, versioned schema rather
 * than a `db push` snapshot.
 */
export async function deployPrismaMigrations(pkg: PrismaPackage, url: string): Promise<void> {
  await runPnpm(
    pkg,
    ["exec", "prisma", "migrate", "deploy", "--schema", "./prisma/schema.prisma"],
    { [ENV_VAR[pkg]]: url },
  );
}

/**
 * Run a workspace package's package.json script (e.g. `seed`) against a specific
 * database. Used to load the demo dataset into a fresh integration container so
 * contract-validated reads have data to return.
 */
export async function runPackageScript(
  pkg: string,
  script: string,
  env: NodeJS.ProcessEnv = {},
): Promise<void> {
  await runPnpm(pkg, [script], env);
}
