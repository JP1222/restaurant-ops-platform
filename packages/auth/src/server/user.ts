import { verify as verifyArgon2 } from "@node-rs/argon2";
import { DEFAULT_TENANT_ID, type WebAdminRole } from "@rop/contracts";
import type { PrismaClient } from "@rop/db-auth";
import type { AuthServiceConfig } from "./config.js";

export async function bootstrapAdminAccount(prisma: PrismaClient, config: AuthServiceConfig) {
  if (!config.webLoginUsername || !config.webLoginPasswordHash) {
    return null;
  }

  // The bootstrap admin is created with a real, usable configured password, so
  // it must carry a non-null `passwordSetAt` — otherwise the lockout guard would
  // wrongly treat this account as password-less and refuse to remove its only
  // passkey. (The migration backfill covers pre-existing rows; this covers a
  // fresh install where bootstrap runs after the empty-table migration.)
  return prisma.webAdminAccount.upsert({
    where: {
      username: config.webLoginUsername
    },
    create: {
      username: config.webLoginUsername,
      displayName: config.webLoginDisplayName,
      passwordHash: config.webLoginPasswordHash,
      passwordSetAt: new Date()
    },
    update: {
      displayName: config.webLoginDisplayName,
      passwordHash: config.webLoginPasswordHash,
      passwordSetAt: new Date()
    }
  });
}

export async function getAdminAccountByUsername(prisma: PrismaClient, username: string) {
  return prisma.webAdminAccount.findUnique({
    where: {
      username
    }
  });
}

// No `select` — the full row (including `passwordSetAt`) is returned, so the
// lockout helper and password-change flow can read whether a usable password
// has ever been established. `passwordSetAt === null` means a placeholder /
// never-redeemed hash the account can't actually log in with.
export async function getAccountById(prisma: PrismaClient, accountId: string) {
  return prisma.webAdminAccount.findUnique({
    where: {
      id: accountId
    }
  });
}

// Multi-tenant Phase 2 (ADR-0818): resolve the tenant an account logs into, from
// its TenantMembership (the *tenant* axis; backfilled to tenant-default by the
// db-auth migration). Today every account has exactly one membership, so first()
// is unambiguous; `orderBy createdAt` keeps it deterministic if that ever changes.
// Falls back to the single implicit tenant for an account with no membership yet
// (e.g. created after the backfill but before account-creation mints one) — a
// safe default in the current single-tenant window, NOT a fail-open for a
// resolved request scope (that hard wall lives in the consumption step).
export async function resolveAccountTenantId(prisma: PrismaClient, accountId: string): Promise<string> {
  const membership = await prisma.tenantMembership.findFirst({
    where: { accountId },
    orderBy: { createdAt: "asc" }
  });
  return membership?.tenantId ?? DEFAULT_TENANT_ID;
}

// Multi-tenant provisioning (ADR-0818 / #902 Phase 0): idempotently ensure an
// account belongs to a tenant. Upserts on @@unique([accountId, tenantId]) so the
// provisionTenant saga can run on every boot as a no-op for an existing
// membership. While `WebAdminAccount.role` is still the live source of truth (pre
// session-claim cutover), the membership role is kept in sync with whatever role
// the caller passes. This is the ONE write path for memberships from outside the
// auth boundary — kds-api's provisionTenant reaches it through the auth service,
// so that saga never imports `@rop/db-auth` (Iron Law 3).
export async function ensureTenantMembership(
  prisma: PrismaClient,
  input: { accountId: string; tenantId: string; role?: WebAdminRole }
) {
  return prisma.tenantMembership.upsert({
    where: {
      accountId_tenantId: { accountId: input.accountId, tenantId: input.tenantId }
    },
    create: {
      accountId: input.accountId,
      tenantId: input.tenantId,
      ...(input.role ? { role: input.role } : {})
    },
    update: input.role ? { role: input.role } : {}
  });
}

export async function verifyAdminPassword(prisma: PrismaClient, username: string, password: string) {
  const account = await getAdminAccountByUsername(prisma, username);
  if (!account) {
    return null;
  }

  const valid = await verifyArgon2(account.passwordHash, password);
  return valid ? account : null;
}

// The single chokepoint for storing a REAL (user-chosen) password hash — both
// changeAccountPassword and setPasswordWithToken flow through here. Stamping
// `passwordSetAt = now()` here (and ONLY here) is what marks an account as
// having a usable password. The creation/placeholder write in
// admin-user-service.ts (kds-api) goes through prisma.create directly and so
// deliberately leaves `passwordSetAt` NULL.
export async function setAccountPassword(prisma: PrismaClient, accountId: string, passwordHash: string) {
  return prisma.webAdminAccount.update({
    where: {
      id: accountId
    },
    data: {
      passwordHash,
      passwordSetAt: new Date()
    }
  });
}
