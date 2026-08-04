import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const PRIMARY = randomBytes(32).toString("hex");
const PREVIOUS = randomBytes(32).toString("hex");
const WRONG = randomBytes(32).toString("hex");

const ENV_KEYS = [
  "APP_SETTING_ENCRYPTION_KEY",
  "APP_SETTING_ENCRYPTION_KEY_PREVIOUS",
] as const;
const originalEnv = new Map<string, string | undefined>();

function snapshotEnv() {
  for (const k of ENV_KEYS) originalEnv.set(k, process.env[k]);
}
function restoreEnv() {
  for (const k of ENV_KEYS) {
    const v = originalEnv.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

// Re-import the module after each env mutation so cached key parsing
// (none today, but defensive against future memoization) doesn't bleed
// across tests.
async function loadCrypto() {
  return import("@/lib/settings/crypto");
}

beforeEach(() => {
  snapshotEnv();
  process.env.APP_SETTING_ENCRYPTION_KEY = PRIMARY;
  delete process.env.APP_SETTING_ENCRYPTION_KEY_PREVIOUS;
});

afterEach(() => {
  restoreEnv();
});

describe("encryptSecret + decryptSecret round-trip", () => {
  test("returns the original plaintext", async () => {
    const { encryptSecret, decryptSecret } = await loadCrypto();
    const plaintext = "sk-deepseek-supersecret-1234567890";
    const envelope = encryptSecret(plaintext);
    expect(decryptSecret(envelope)).toBe(plaintext);
  });

  test("envelope is JSON with the expected shape and version", async () => {
    const { encryptSecret } = await loadCrypto();
    const envelope = JSON.parse(encryptSecret("anything"));
    expect(envelope.enc).toBe("aes-gcm-v1");
    expect(typeof envelope.nonce).toBe("string");
    expect(typeof envelope.ct).toBe("string");
    expect(typeof envelope.tag).toBe("string");
    // hex string lengths: 12-byte nonce -> 24 hex; 16-byte tag -> 32 hex.
    expect(envelope.nonce).toHaveLength(24);
    expect(envelope.tag).toHaveLength(32);
  });

  test("two encryptions of the same plaintext produce different ciphertexts", async () => {
    // Randomized nonce: identical plaintext must not collide on the wire.
    const { encryptSecret } = await loadCrypto();
    const a = JSON.parse(encryptSecret("same"));
    const b = JSON.parse(encryptSecret("same"));
    expect(a.ct).not.toBe(b.ct);
    expect(a.nonce).not.toBe(b.nonce);
  });
});

describe("tamper / wrong-key failure paths", () => {
  test("flipping a ciphertext byte fails the auth tag", async () => {
    const { encryptSecret, decryptSecret, SettingDecryptError } =
      await loadCrypto();
    const envelope = JSON.parse(encryptSecret("payload"));
    // Flip one nibble in the middle of the ciphertext.
    const ct = envelope.ct;
    const flipped =
      ct.slice(0, 2) +
      (ct[2] === "0" ? "f" : "0") +
      ct.slice(3);
    envelope.ct = flipped;
    expect(() => decryptSecret(JSON.stringify(envelope))).toThrow(
      SettingDecryptError,
    );
  });

  test("a different primary key (no previous configured) throws SettingDecryptError", async () => {
    const { encryptSecret } = await loadCrypto();
    const envelope = encryptSecret("payload");
    // Rotate primary to a fresh unrelated key, no previous.
    process.env.APP_SETTING_ENCRYPTION_KEY = WRONG;
    delete process.env.APP_SETTING_ENCRYPTION_KEY_PREVIOUS;
    const { decryptSecret, SettingDecryptError } = await loadCrypto();
    expect(() => decryptSecret(envelope)).toThrow(SettingDecryptError);
  });

  test("malformed envelope (non-JSON) throws SettingDecryptError", async () => {
    const { decryptSecret, SettingDecryptError } = await loadCrypto();
    expect(() => decryptSecret("not-json")).toThrow(SettingDecryptError);
  });

  test("envelope with wrong `enc` version throws SettingDecryptError", async () => {
    const { decryptSecret, SettingDecryptError } = await loadCrypto();
    const envelope = JSON.stringify({
      enc: "aes-gcm-v9",
      nonce: "00".repeat(12),
      ct: "00",
      tag: "00".repeat(16),
    });
    expect(() => decryptSecret(envelope)).toThrow(SettingDecryptError);
  });
});

describe("dual-key transition (rotation)", () => {
  test("ciphertext written under previous key still decrypts after rotation", async () => {
    // Encrypt under "old" key.
    process.env.APP_SETTING_ENCRYPTION_KEY = PREVIOUS;
    delete process.env.APP_SETTING_ENCRYPTION_KEY_PREVIOUS;
    const beforeRotate = await loadCrypto();
    const oldEnvelope = beforeRotate.encryptSecret("rotated-payload");

    // Rotate: primary = new, previous = old.
    process.env.APP_SETTING_ENCRYPTION_KEY = PRIMARY;
    process.env.APP_SETTING_ENCRYPTION_KEY_PREVIOUS = PREVIOUS;
    const afterRotate = await loadCrypto();

    // Reading the OLD envelope should fall back to PREVIOUS and succeed.
    expect(afterRotate.decryptSecret(oldEnvelope)).toBe("rotated-payload");

    // New writes are encrypted under the new key — should round-trip.
    const newEnvelope = afterRotate.encryptSecret("fresh-payload");
    expect(afterRotate.decryptSecret(newEnvelope)).toBe("fresh-payload");
  });

  test("both keys wrong -> SettingDecryptError", async () => {
    process.env.APP_SETTING_ENCRYPTION_KEY = PRIMARY;
    const { encryptSecret } = await loadCrypto();
    const envelope = encryptSecret("payload");
    process.env.APP_SETTING_ENCRYPTION_KEY = WRONG;
    process.env.APP_SETTING_ENCRYPTION_KEY_PREVIOUS = randomBytes(32).toString(
      "hex",
    );
    const { decryptSecret, SettingDecryptError } = await loadCrypto();
    expect(() => decryptSecret(envelope)).toThrow(SettingDecryptError);
  });
});

describe("boot validation (assertEncryptionKeysAtBoot)", () => {
  test("missing primary key throws at boot", async () => {
    delete process.env.APP_SETTING_ENCRYPTION_KEY;
    const { assertEncryptionKeysAtBoot } = await loadCrypto();
    expect(() => assertEncryptionKeysAtBoot()).toThrow(
      /APP_SETTING_ENCRYPTION_KEY missing/,
    );
  });

  test("malformed primary key (wrong length) throws at boot", async () => {
    process.env.APP_SETTING_ENCRYPTION_KEY = "deadbeef";
    const { assertEncryptionKeysAtBoot } = await loadCrypto();
    expect(() => assertEncryptionKeysAtBoot()).toThrow(/64 chars/);
  });

  test("non-hex primary key throws at boot", async () => {
    process.env.APP_SETTING_ENCRYPTION_KEY = "z".repeat(64);
    const { assertEncryptionKeysAtBoot } = await loadCrypto();
    expect(() => assertEncryptionKeysAtBoot()).toThrow(/hex characters/);
  });

  test("malformed previous key also throws at boot", async () => {
    process.env.APP_SETTING_ENCRYPTION_KEY = PRIMARY;
    process.env.APP_SETTING_ENCRYPTION_KEY_PREVIOUS = "tooshort";
    const { assertEncryptionKeysAtBoot } = await loadCrypto();
    expect(() => assertEncryptionKeysAtBoot()).toThrow(/PREVIOUS/);
  });

  test("valid primary + no previous passes", async () => {
    const { assertEncryptionKeysAtBoot } = await loadCrypto();
    expect(() => assertEncryptionKeysAtBoot()).not.toThrow();
  });

  test("valid primary + valid previous passes", async () => {
    process.env.APP_SETTING_ENCRYPTION_KEY_PREVIOUS = PREVIOUS;
    const { assertEncryptionKeysAtBoot } = await loadCrypto();
    expect(() => assertEncryptionKeysAtBoot()).not.toThrow();
  });
});
