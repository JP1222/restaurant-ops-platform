import { afterEach, describe, expect, it } from "vitest";

import { assertAiTokenEncryptionKey } from "../src/lib/crypto/encryption.js";

// The eager boot gate (index.ts / worker.ts) that would have turned the
// 2026-06-18 ~13h crash-loop into one legible boot error. It must agree with
// what encryption.ts actually accepts (both go through the same validator).
describe("assertAiTokenEncryptionKey", () => {
  const original = process.env.AI_TOKEN_ENCRYPTION_KEY;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.AI_TOKEN_ENCRYPTION_KEY;
    } else {
      process.env.AI_TOKEN_ENCRYPTION_KEY = original;
    }
  });

  it("passes for a 64-char hex key", () => {
    process.env.AI_TOKEN_ENCRYPTION_KEY = "a".repeat(64);
    expect(() => assertAiTokenEncryptionKey()).not.toThrow();
  });

  it("throws a clear, named error when the key is unset", () => {
    delete process.env.AI_TOKEN_ENCRYPTION_KEY;
    expect(() => assertAiTokenEncryptionKey()).toThrow(/AI_TOKEN_ENCRYPTION_KEY missing/);
  });

  it("throws when the key is the wrong length", () => {
    process.env.AI_TOKEN_ENCRYPTION_KEY = "deadbeef";
    expect(() => assertAiTokenEncryptionKey()).toThrow(/32-byte hex/);
  });
});
