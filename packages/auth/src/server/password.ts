import { Algorithm, hash, verify, type Options } from "@node-rs/argon2";

// Pinned argon2id parameters for all password / PIN hashes in the suite.
//
// Why pin: @node-rs/argon2's built-in defaults are reasonable today, but they
// are unpinned — a future minor bump could silently change them and downgrade
// strength, and divergent defaults across deployments could make hashes
// unverifiable. Pinning here makes the work factor explicit and reviewable.
//
// Upgrade path: argon2id encodes its parameters into the PHC string
// (`$argon2id$v=19$m=...,t=...,p=...$<salt>$<hash>`), so `verifyPassword`
// keeps validating older hashes produced with different parameters — `verify`
// reads the cost from the encoded string, not from these constants. New hashes
// produced by `hashPassword` use the pinned values below; to roll the work
// factor forward, bump a constant and existing users re-hash on next login.
//
// Values follow OWASP's argon2id guidance (m >= 19 MiB, t >= 2) with extra
// headroom: 64 MiB / 3 passes / single lane.
export const ARGON2_MEMORY_COST = 65536; // KiB (64 MiB) per lane
export const ARGON2_TIME_COST = 3; // passes / iterations
export const ARGON2_PARALLELISM = 1; // lanes
export const ARGON2_OUTPUT_LEN = 32; // raw hash bytes (43-char digest)
export const ARGON2_ALGORITHM = Algorithm.Argon2id;

export const ARGON2_HASH_OPTIONS: Options = {
  memoryCost: ARGON2_MEMORY_COST,
  timeCost: ARGON2_TIME_COST,
  parallelism: ARGON2_PARALLELISM,
  outputLen: ARGON2_OUTPUT_LEN,
  algorithm: ARGON2_ALGORITHM
};

export async function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, ARGON2_HASH_OPTIONS);
}

export async function verifyPassword(plaintext: string, hashed: string): Promise<boolean> {
  try {
    // Intentionally no options: argon2 reads the work factor from the encoded
    // PHC string, so this verifies both legacy hashes and ones produced with
    // ARGON2_HASH_OPTIONS above.
    return await verify(hashed, plaintext);
  } catch {
    return false;
  }
}
