import { randomBytes } from "node:crypto";
import { parseJson } from "./json.js";
import type { AuthRedis } from "./redis.js";

// One-time, single-use, short-TTL token that backs both the invite (new
// account) and reset (locked-out account) flows (ADR-0029 P2). Mirrors the
// webauthn flow storage: an opaque Redis-backed token, deleted on read. The
// holder redeems it on the public /set-password page to choose a password —
// no system-generated password is ever shown or emailed.
const PASSWORD_SETUP_KEY_PREFIX = "auth:password-setup:";
export const PASSWORD_SETUP_TTL_SECONDS = 60 * 60;

export type PasswordSetupPurpose = "invite" | "reset";

type PasswordSetupRecord = {
  accountId: string;
  purpose: PasswordSetupPurpose;
  issuedAt: string;
};

function setupKey(token: string) {
  return `${PASSWORD_SETUP_KEY_PREFIX}${token}`;
}

export async function createPasswordSetupToken(
  redis: AuthRedis,
  accountId: string,
  purpose: PasswordSetupPurpose,
): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const record: PasswordSetupRecord = {
    accountId,
    purpose,
    issuedAt: new Date().toISOString(),
  };
  await redis.set(setupKey(token), JSON.stringify(record), "EX", PASSWORD_SETUP_TTL_SECONDS);
  return token;
}

// Single-use: the record is deleted on read, so a token redeems exactly once.
export async function consumePasswordSetupToken(
  redis: AuthRedis,
  token: string | undefined,
): Promise<{ accountId: string; purpose: PasswordSetupPurpose } | null> {
  if (!token) {
    return null;
  }
  const key = setupKey(token);
  const raw = await redis.get(key);
  await redis.del(key);
  const parsed = parseJson<PasswordSetupRecord>(raw);
  if (!parsed) {
    return null;
  }
  return { accountId: parsed.accountId, purpose: parsed.purpose };
}
