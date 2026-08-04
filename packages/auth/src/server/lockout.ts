import { Prisma, type PrismaClient } from "@rop/db-auth";
import { getPasskeyCount } from "./passkey.js";
import { getAccountById } from "./user.js";

// A snapshot of an account's usable login methods. `passwordSet` reflects
// `passwordSetAt != null` (a placeholder/never-redeemed hash is NOT usable);
// `passkeyCount` reuses the canonical credential count. `total` is the count of
// usable methods the lockout invariant must keep >= 1.
export type LoginMethodState = {
  passwordSet: boolean;
  passkeyCount: number;
  total: number;
};

// Reads the current usable-login-method state for an account. Returns
// `passwordSet: false` (and `total` excluding the password) for an unknown
// account — the caller decides how to treat a missing account.
export async function countUsableLoginMethods(
  prisma: PrismaClient,
  accountId: string,
): Promise<LoginMethodState> {
  const [account, passkeyCount] = await Promise.all([
    getAccountById(prisma, accountId),
    getPasskeyCount(prisma, accountId),
  ]);

  const passwordSet = account?.passwordSetAt != null;
  return {
    passwordSet,
    passkeyCount,
    total: (passwordSet ? 1 : 0) + passkeyCount,
  };
}

// Pure predicate: would removing the given method leave the account with zero
// usable login methods? Currently only passkey removal can do this — deleting a
// passkey is unsafe only when there is no usable password AND it is the last
// passkey. (Password removal is not a supported operation; a password is
// replaced, never cleared, so it is not modeled here.) Keep throw-vs-return at
// the call site so each app maps its own error code/status.
export function wouldLeaveNoLoginMethod(
  state: Pick<LoginMethodState, "passwordSet" | "passkeyCount">,
  removing: "passkey",
): boolean {
  if (removing === "passkey") {
    return !state.passwordSet && state.passkeyCount <= 1;
  }
  return false;
}

// Outcome of a guarded passkey deletion. `not_found` → the credential is not
// this account's (callers map to 404); `last_login_method` → removing it would
// leave the account with zero usable login methods (callers map to 409 for the
// self-service surfaces, 422 for manage-others). The helper never throws on a
// business reason — it returns one, so each surface owns its own HTTP mapping.
export type GuardedPasskeyDeletion =
  | { ok: true }
  | { ok: false; reason: "not_found" | "last_login_method" };

const SERIALIZATION_FAILURE_MAX_ATTEMPTS = 3;

// A Serializable transaction may abort with a serialization failure under write
// contention. Prisma surfaces that as a known-request P2034; some driver/adapter
// paths bubble the raw SQLSTATE instead (40001 serialization_failure, 40P01
// deadlock_detected) on an unknown-request error. Both are transient lost-races,
// not real faults.
function isSerializationFailure(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return error.code === "P2034";
  }
  if (error instanceof Prisma.PrismaClientUnknownRequestError) {
    return /\b40001\b|\b40P01\b/.test(error.message);
  }
  return false;
}

// Bounded retry for Serializable transactions. A serialization failure means a
// concurrent writer won the race and this transaction was rolled back with NO
// effect, so retrying is safe: the next attempt re-reads the now-committed state
// and reaches a correct decision (e.g. the loser of a last-passkey race now sees
// `last_login_method` and is rejected cleanly instead of surfacing a 500). A
// non-serialization error (including a business `throw`) is re-thrown untouched.
export async function withSerializationRetry<T>(
  run: () => Promise<T>,
  maxAttempts: number = SERIALIZATION_FAILURE_MAX_ATTEMPTS,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= maxAttempts || !isSerializationFailure(error)) {
        throw error;
      }
    }
  }
}

// Transactional, existence-first guarded passkey deletion — the single shared
// implementation behind every revoke path (admin manage-others + both
// self-service surfaces). Closes the check-then-act TOCTOU (review sec-2): the
// existence check, the lockout re-read, and the delete all run inside ONE
// Serializable transaction, so two concurrent removals of the last passkey of a
// password-less account cannot both pass the guard and leave zero login methods.
// Ordering existence FIRST also reconciles the surfaces (review LOCKOUT-03): a
// stale/foreign credentialId is a `not_found` (404), never a lockout reason
// masking the real 404.
export async function deletePasskeyGuarded(
  prisma: PrismaClient,
  accountId: string,
  credentialId: string,
): Promise<GuardedPasskeyDeletion> {
  return withSerializationRetry(() =>
    prisma.$transaction(
      async (tx): Promise<GuardedPasskeyDeletion> => {
        // (a) existence-first, scoped to the account so a credential owned by a
        // different account is indistinguishable from a missing one.
        const credential = await tx.webAuthnCredential.findFirst({
          where: { accountId, credentialId },
          select: { id: true },
        });
        if (!credential) {
          return { ok: false, reason: "not_found" };
        }

        // (b) re-read the usable-login state INSIDE the tx so it is snapshot-
        // consistent with the delete below. Mirrors countUsableLoginMethods but
        // against the transaction client.
        const [account, passkeyCount] = await Promise.all([
          tx.webAdminAccount.findUnique({
            where: { id: accountId },
            select: { passwordSetAt: true },
          }),
          tx.webAuthnCredential.count({ where: { accountId } }),
        ]);
        const passwordSet = account?.passwordSetAt != null;
        if (wouldLeaveNoLoginMethod({ passwordSet, passkeyCount }, "passkey")) {
          return { ok: false, reason: "last_login_method" };
        }

        // (c) delete. deleteMany keeps parity with the rest of the passkey layer
        // and stays an idempotent scoped write.
        await tx.webAuthnCredential.deleteMany({ where: { accountId, credentialId } });
        return { ok: true };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}
