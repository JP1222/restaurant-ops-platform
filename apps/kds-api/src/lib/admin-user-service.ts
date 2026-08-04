import { randomBytes } from "node:crypto";
import { deletePasskeyGuarded, hashPassword, withSerializationRetry } from "@rop/auth/server";
import type { AdminUserErrorCode } from "@rop/contracts";
import { Prisma, type PrismaClient, type WebAdminAccount, type WebAdminRole } from "@rop/db-auth";

const ONE_TIME_PASSWORD_BYTES = 12;

export class UserAdminError extends Error {
  constructor(public readonly code: AdminUserErrorCode) {
    super(code);
    this.name = "UserAdminError";
  }
}

export interface AdminUserSummary {
  id: string;
  username: string;
  displayName: string;
  role: WebAdminRole;
  createdAt: Date;
  updatedAt: Date;
  passkeyCount: number;
}

export function generateOneTimePassword() {
  // base64url is URL-safe; 12 bytes yields 16 chars and ~96 bits of entropy.
  return randomBytes(ONE_TIME_PASSWORD_BYTES).toString("base64url");
}

function serializeAccount(
  account: Pick<WebAdminAccount, "id" | "username" | "displayName" | "role" | "createdAt" | "updatedAt"> & {
    _count: { credentials: number };
  }
): AdminUserSummary {
  return {
    id: account.id,
    username: account.username,
    displayName: account.displayName,
    role: account.role,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    passkeyCount: account._count.credentials
  };
}

export async function listAdminUsers(prisma: PrismaClient): Promise<AdminUserSummary[]> {
  const accounts = await prisma.webAdminAccount.findMany({
    select: {
      id: true,
      username: true,
      displayName: true,
      role: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { credentials: true } }
    },
    orderBy: { createdAt: "asc" }
  });
  return accounts.map(serializeAccount);
}

export async function createAdminUser(
  prisma: PrismaClient,
  input: { username: string; displayName: string }
): Promise<AdminUserSummary> {
  const username = input.username.trim();
  const displayName = input.displayName.trim();

  const existing = await prisma.webAdminAccount.findUnique({
    where: { username },
    select: { id: true }
  });
  if (existing) {
    throw new UserAdminError("username_taken");
  }

  // The account starts with an unguessable placeholder password it can never
  // be logged into with; the operator shares a one-time setup link (ADR-0029
  // P2) and the user chooses their own password through it.
  const passwordHash = await hashPassword(generateOneTimePassword());

  const created = await prisma.webAdminAccount.create({
    data: {
      username,
      displayName,
      passwordHash
    },
    select: {
      id: true,
      username: true,
      displayName: true,
      role: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { credentials: true } }
    }
  });

  return serializeAccount(created);
}

export async function updateAdminUser(
  prisma: PrismaClient,
  userId: string,
  input: { displayName: string }
): Promise<AdminUserSummary> {
  const existing = await prisma.webAdminAccount.findUnique({
    where: { id: userId },
    select: { id: true }
  });
  if (!existing) {
    throw new UserAdminError("user_not_found");
  }

  const updated = await prisma.webAdminAccount.update({
    where: { id: userId },
    data: { displayName: input.displayName.trim() },
    select: {
      id: true,
      username: true,
      displayName: true,
      role: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { credentials: true } }
    }
  });
  return serializeAccount(updated);
}

export async function deleteAdminUser(prisma: PrismaClient, userId: string): Promise<void> {
  // Single serializable transaction so the guards and the delete observe one
  // consistent snapshot — this closes the TOCTOU that the prior check-then-act
  // (count() then a separate $transaction) left open against a concurrent
  // delete/demote racing the last-admin / last-owner invariants. Wrapped in a
  // bounded serialization-failure retry (review LOCKOUT-04) so a concurrent
  // delete that loses the serialize race retries cleanly instead of surfacing a
  // 500; a business UserAdminError is not a serialization failure, so it is
  // re-thrown on the first attempt (no spurious retries).
  await withSerializationRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const target = await tx.webAdminAccount.findUnique({
          where: { id: userId },
          select: { id: true, role: true }
        });
        if (!target) {
          throw new UserAdminError("user_not_found");
        }

        const total = await tx.webAdminAccount.count();
        if (total <= 1) {
          // Refuse to leave the system with zero admins.
          throw new UserAdminError("last_admin");
        }

        // Refuse to remove the last *usable* OWNER. Read the role from the row
        // rather than assuming it. A surviving OWNER only protects the system if
        // it can actually sign in — i.e. it has a real password (`passwordSetAt`
        // set) OR at least one passkey. A never-redeemed invite (placeholder
        // password, `passwordSetAt` NULL, no credentials) is an OWNER row that
        // CANNOT log in, so it must NOT satisfy this guard — otherwise deleting
        // the only real owner while such a placeholder survives would brick the
        // whole system. Recovery is an OWNER-issued reset setup-link.
        if (target.role === "OWNER") {
          const otherUsableOwners = await tx.webAdminAccount.count({
            where: {
              role: "OWNER",
              id: { not: userId },
              OR: [{ passwordSetAt: { not: null } }, { credentials: { some: {} } }]
            }
          });
          if (otherUsableOwners === 0) {
            throw new UserAdminError("last_owner");
          }
        }

        await tx.webAuthnCredential.deleteMany({ where: { accountId: userId } });
        await tx.webAdminAccount.delete({ where: { id: userId } });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    )
  );
}

// Verify an admin account exists before issuing a one-time setup link
// (ADR-0029 P2). Reset no longer mints a password — the user chooses one via
// the link — so the existing password and sessions stay valid until redeemed.
export async function assertAdminUserExists(prisma: PrismaClient, userId: string): Promise<void> {
  const existing = await prisma.webAdminAccount.findUnique({
    where: { id: userId },
    select: { id: true }
  });
  if (!existing) {
    throw new UserAdminError("user_not_found");
  }
}

export async function revokeAdminUserPasskey(
  prisma: PrismaClient,
  userId: string,
  credentialId: string
): Promise<void> {
  // Manage-others revoke shares the exact transactional, existence-first guard
  // as the two self-service surfaces (packages/auth deletePasskeyGuarded): one
  // Serializable transaction does existence → lockout re-read → delete, closing
  // the check-then-act TOCTOU (review sec-2). Translate the discriminated result
  // into the UserAdminError codes the admin route already maps — not_found →
  // passkey_not_found (404), last_login_method → 422.
  const result = await deletePasskeyGuarded(prisma, userId, credentialId);
  if (!result.ok) {
    throw new UserAdminError(
      result.reason === "not_found" ? "passkey_not_found" : "last_login_method"
    );
  }
}
