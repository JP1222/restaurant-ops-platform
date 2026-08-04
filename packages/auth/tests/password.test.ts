import { describe, expect, it } from "vitest";
import {
  ARGON2_MEMORY_COST,
  ARGON2_PARALLELISM,
  ARGON2_TIME_COST,
  hashPassword,
  verifyPassword
} from "../src/server/password.js";

// Argon2id hashing is deliberately CPU/memory-hard (64 MiB, 3 passes), so tests
// that compute real hashes can exceed vitest's default 5s timeout when a CI
// runner is under load (flaked at 5011ms on the self-hosted Mac pool).
const ARGON2_TEST_TIMEOUT_MS = 20_000;

describe("password helpers", () => {
  it(
    "hashes and verifies valid passwords",
    async () => {
      const hashed = await hashPassword("correct horse battery staple");

      expect(hashed).toContain("$argon2");
      await expect(verifyPassword("correct horse battery staple", hashed)).resolves.toBe(true);
    },
    ARGON2_TEST_TIMEOUT_MS
  );

  it(
    "rejects mismatched passwords",
    async () => {
      const hashed = await hashPassword("correct horse battery staple");

      await expect(verifyPassword("wrong password", hashed)).resolves.toBe(false);
    },
    ARGON2_TEST_TIMEOUT_MS
  );

  it("treats malformed hashes as failed verification", async () => {
    await expect(verifyPassword("password", "not-an-argon2-hash")).resolves.toBe(false);
  });

  it(
    "produces an argon2id PHC string with the pinned parameters",
    async () => {
      const hashed = await hashPassword("correct horse battery staple");

      // PHC format: $argon2id$v=19$m=<memoryCost>,t=<timeCost>,p=<parallelism>$<salt>$<hash>
      expect(hashed.startsWith("$argon2id$")).toBe(true);
      expect(hashed).toMatch(
        new RegExp(`\\$m=${ARGON2_MEMORY_COST},t=${ARGON2_TIME_COST},p=${ARGON2_PARALLELISM}\\$`)
      );
    },
    ARGON2_TEST_TIMEOUT_MS
  );
});
