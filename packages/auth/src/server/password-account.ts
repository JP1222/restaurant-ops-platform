import type { PrismaClient } from "@rop/db-auth";
import type { PasswordRejectionReason } from "@rop/contracts";
import { hashPassword, verifyPassword } from "./password.js";
import { validatePasswordStrength } from "./password-policy.js";
import { consumePasswordSetupToken } from "./password-setup.js";
import { getAccountById, setAccountPassword } from "./user.js";
import type { AuthRedis } from "./redis.js";

export type PasswordMutationResult =
  | { ok: true }
  | { ok: false; reason: PasswordRejectionReason; message: string };

// Self-service change (session-gated): prove the current password, then choose
// a new one. The new password is breach-checked and length-validated before
// it is hashed and stored.
export async function changeAccountPassword(
  prisma: PrismaClient,
  input: { accountId: string; currentPassword: string; newPassword: string },
): Promise<PasswordMutationResult> {
  const account = await getAccountById(prisma, input.accountId);
  if (!account || !(await verifyPassword(input.currentPassword, account.passwordHash))) {
    return { ok: false, reason: "incorrect_current", message: "Current password is incorrect." };
  }

  const strength = await validatePasswordStrength(input.newPassword);
  if (!strength.ok) {
    return strength;
  }

  await setAccountPassword(prisma, account.id, await hashPassword(input.newPassword));
  return { ok: true };
}

// Token-gated set (invite / reset redemption). Strength is validated BEFORE the
// token is consumed so a weak choice does not burn the single-use link — the
// holder can retry with the same link.
export async function setPasswordWithToken(
  prisma: PrismaClient,
  redis: AuthRedis,
  input: { token: string; newPassword: string },
): Promise<PasswordMutationResult> {
  const strength = await validatePasswordStrength(input.newPassword);
  if (!strength.ok) {
    return strength;
  }

  const consumed = await consumePasswordSetupToken(redis, input.token);
  if (!consumed) {
    return { ok: false, reason: "token_invalid", message: "This link is invalid or has expired." };
  }

  const account = await getAccountById(prisma, consumed.accountId);
  if (!account) {
    return { ok: false, reason: "token_invalid", message: "This account no longer exists." };
  }

  await setAccountPassword(prisma, account.id, await hashPassword(input.newPassword));
  return { ok: true };
}
