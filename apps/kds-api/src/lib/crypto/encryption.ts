import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM envelope for secrets stored at rest.
 *
 * Output layout: `[12-byte nonce | ciphertext | 16-byte auth tag]` packed into
 * a single `Buffer`. The nonce is randomized per call so the same plaintext
 * encrypts to a different ciphertext every time, which prevents an attacker
 * with read access to the DB from correlating identical secrets.
 *
 * Master key source: `AI_TOKEN_ENCRYPTION_KEY` env var (32-byte hex / 64 chars).
 * Generate one with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 * CRITICAL: key loss = every encrypted row becomes unreadable. Operators must
 * store the master key out-of-band in a password manager.
 *
 * Scope: kds-api only (server + worker). The backoffice has a SEPARATE at-rest
 * store — `apps/backoffice-web/lib/settings/crypto.ts` — with its own distinct
 * master key (`APP_SETTING_ENCRYPTION_KEY`) and a different envelope format
 * (a JSON `{enc,nonce,ct,tag}` string, not this packed binary buffer). The two
 * are deliberately independent: a leak of one key never exposes the other, so
 * they are NOT "one shared master key." Promote this to a shared
 * `packages/crypto` only once a genuine third caller emerges.
 */
const ALGO = "aes-256-gcm";
const NONCE_LEN = 12;
const TAG_LEN = 16;

function readValidatedKeyHex(): string {
  const hex = process.env.AI_TOKEN_ENCRYPTION_KEY;
  if (!hex) {
    throw new Error(
      "AI_TOKEN_ENCRYPTION_KEY missing — generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }
  if (hex.length !== 64) {
    throw new Error("AI_TOKEN_ENCRYPTION_KEY must be 32-byte hex (64 chars)");
  }
  return hex;
}

/**
 * Eager boot-time validation of the master key. Call this once at startup —
 * `index.ts` and `worker.ts` invoke it right after `loadConfig()` — so a
 * missing/malformed key fails FAST with a legible message instead of
 * crash-looping deep inside the first encrypt. That lazy-throw path is exactly
 * what caused the 2026-06-18 ~13h KDS outage: the key was never injected and
 * the error only surfaced inside `bootstrapMerchantFromEnv`. `getKey()` shares
 * this validator so the eager gate and the per-call read never drift.
 */
export function assertAiTokenEncryptionKey(): void {
  readValidatedKeyHex();
}

function getKey(): Buffer {
  return Buffer.from(readValidatedKeyHex(), "hex");
}

/** Encrypts `plaintext` and returns a self-contained Buffer (nonce || ct || tag). */
export function encryptSecret(plaintext: string): Buffer {
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv(ALGO, getKey(), nonce);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, enc, tag]);
}

/** Decrypts a Buffer produced by `encryptSecret`. Throws on tamper/wrong key. */
export function decryptSecret(blob: Buffer): string {
  if (blob.length < NONCE_LEN + TAG_LEN + 1) {
    throw new Error("ciphertext too short");
  }
  const nonce = blob.subarray(0, NONCE_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  const enc = blob.subarray(NONCE_LEN, blob.length - TAG_LEN);
  const decipher = createDecipheriv(ALGO, getKey(), nonce);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString("utf8");
}

/**
 * Prisma represents `Bytes` columns as `Uint8Array<ArrayBuffer>` in the
 * generated types. `encryptSecret` returns a Node `Buffer` (which extends
 * Uint8Array but carries `ArrayBufferLike`). This helper produces a fresh
 * Uint8Array view over the same bytes that Prisma's input/output types both
 * accept. Mirrors the helper in apps/backoffice-web/lib/ai/oauth/profile.ts.
 */
export function toBytes(input: Buffer): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(input.length));
  out.set(input);
  return out;
}
