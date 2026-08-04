import { createHash, timingSafeEqual } from "node:crypto";

// Both sides are hashed before comparing: timingSafeEqual throws on buffers of
// different lengths, and an early length check would leak the token's length
// to a probing client. SHA-256 normalizes both to 32 bytes so the comparison
// is constant-time regardless of what the client sent.
export function matchesInternalBearer(
  authorization: string | undefined,
  token: string
): boolean {
  if (typeof authorization !== "string") {
    return false;
  }
  const provided = createHash("sha256").update(authorization).digest();
  const expected = createHash("sha256").update(`Bearer ${token}`).digest();
  return timingSafeEqual(provided, expected);
}
