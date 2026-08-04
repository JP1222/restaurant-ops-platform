import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM at-rest encryption for AppSetting rows with `category=secret`.
 *
 * Storage shape (JSON-encoded into the existing `app_setting.value` String
 * column — no schema migration needed):
 *   { enc: "aes-gcm-v1", nonce: "<hex>", ct: "<hex>", tag: "<hex>" }
 *
 * We pack the envelope into `value` rather than adding a sibling
 * `value_encrypted` Bytes column because:
 *   1. The reader/writer already round-trips `value` as a JSON-encoded string
 *      (`JSON.stringify(validation.value)` in PUT /api/settings) — riding that
 *      same JSON channel keeps the reader/writer wiring symmetric.
 *   2. The `enc` discriminator lets us add v2/v3 schemes without a migration.
 *   3. Single-merchant scope; per-row envelope encryption is rejected by #244.
 *
 * Master key sources (both 32-byte hex / 64 chars):
 *   - `APP_SETTING_ENCRYPTION_KEY`           required, used for encrypt + decrypt
 *   - `APP_SETTING_ENCRYPTION_KEY_PREVIOUS`  optional, decrypt-only fallback
 *     during rotation. On decrypt, the current key is tried first; if the auth
 *     tag fails, the previous key is tried; if both fail, `SettingDecryptError`
 *     is thrown. Operators rotate by: set new key as PRIMARY, leave the old
 *     one as PREVIOUS, redeploy, re-write every secret row (which encrypts
 *     with the new key), then drop PREVIOUS from env on the next deploy.
 *
 * The keys are NEVER logged. The ciphertext content is NEVER logged. The
 * `enc`-tagged envelope is logged on decrypt failure so operators can tell
 * which row is broken.
 *
 * Module-load-time validation: `assertEncryptionKeysAtBoot()` is invoked at
 * import so a missing/malformed primary key takes down the route at first
 * import rather than at first secret read. Tests stub the env before import.
 */

const ALGO = "aes-256-gcm";
const NONCE_LEN = 12;
const ENVELOPE_VERSION = "aes-gcm-v1" as const;
const HEX_RE = /^[0-9a-fA-F]+$/;

export class SettingDecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingDecryptError";
  }
}

interface EncryptedEnvelope {
  enc: typeof ENVELOPE_VERSION;
  nonce: string;
  ct: string;
  tag: string;
}

function parseKey(envName: string, hex: string): Buffer {
  if (hex.length !== 64) {
    throw new Error(`${envName} must be 32-byte hex (64 chars), got ${hex.length}`);
  }
  if (!HEX_RE.test(hex)) {
    throw new Error(`${envName} must be hex characters [0-9a-f] only`);
  }
  return Buffer.from(hex, "hex");
}

function getPrimaryKey(): Buffer {
  const hex = process.env.APP_SETTING_ENCRYPTION_KEY;
  if (!hex) {
    throw new Error(
      "APP_SETTING_ENCRYPTION_KEY missing — generate one with: openssl rand -hex 32",
    );
  }
  return parseKey("APP_SETTING_ENCRYPTION_KEY", hex);
}

function getPreviousKey(): Buffer | null {
  const hex = process.env.APP_SETTING_ENCRYPTION_KEY_PREVIOUS;
  if (!hex) return null;
  return parseKey("APP_SETTING_ENCRYPTION_KEY_PREVIOUS", hex);
}

/**
 * Fail-fast boot check. Call from app startup (or from module-load of any
 * route that touches secrets). A missing primary key throws here; a
 * malformed previous key also throws so silent rotation errors don't ship.
 */
export function assertEncryptionKeysAtBoot(): void {
  getPrimaryKey();
  getPreviousKey();
}

/** Encrypts `plaintext` and returns the JSON-encoded envelope string. */
export function encryptSecret(plaintext: string): string {
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv(ALGO, getPrimaryKey(), nonce);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const envelope: EncryptedEnvelope = {
    enc: ENVELOPE_VERSION,
    nonce: nonce.toString("hex"),
    ct: ct.toString("hex"),
    tag: tag.toString("hex"),
  };
  return JSON.stringify(envelope);
}

function tryDecrypt(env: EncryptedEnvelope, key: Buffer): string {
  const nonce = Buffer.from(env.nonce, "hex");
  const tag = Buffer.from(env.tag, "hex");
  const ct = Buffer.from(env.ct, "hex");
  const decipher = createDecipheriv(ALGO, key, nonce);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(ct), decipher.final()]);
  return dec.toString("utf8");
}

function parseEnvelope(stored: string): EncryptedEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    throw new SettingDecryptError("envelope is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new SettingDecryptError("envelope is not an object");
  }
  const e = parsed as Record<string, unknown>;
  if (e.enc !== ENVELOPE_VERSION) {
    throw new SettingDecryptError(`unknown envelope version: ${String(e.enc)}`);
  }
  if (typeof e.nonce !== "string" || typeof e.ct !== "string" || typeof e.tag !== "string") {
    throw new SettingDecryptError("envelope is missing nonce/ct/tag");
  }
  return { enc: ENVELOPE_VERSION, nonce: e.nonce, ct: e.ct, tag: e.tag };
}

/**
 * Decrypts a stored envelope. Tries the primary key first; on auth-tag
 * failure, falls back to the previous key if configured. Throws
 * `SettingDecryptError` if both fail or the envelope is malformed.
 *
 * Caller is responsible for the structured log. The error message names the
 * envelope version and the failure mode, but NEVER the key or plaintext.
 */
export function decryptSecret(stored: string): string {
  const envelope = parseEnvelope(stored);
  try {
    return tryDecrypt(envelope, getPrimaryKey());
  } catch (primaryErr) {
    const previous = getPreviousKey();
    if (!previous) {
      throw new SettingDecryptError(
        `decrypt failed with primary key (${ENVELOPE_VERSION}); no previous key configured`,
      );
    }
    try {
      return tryDecrypt(envelope, previous);
    } catch {
      throw new SettingDecryptError(
        `decrypt failed with both primary and previous keys (${ENVELOPE_VERSION})`,
      );
    } finally {
      void primaryErr;
    }
  }
}

