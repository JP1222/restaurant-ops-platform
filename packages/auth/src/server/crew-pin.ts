import { createHmac, timingSafeEqual } from "node:crypto";

import { hashPassword, verifyPassword } from "./password.js";

// Crew PIN auth for shared floor devices (apps/crew-web -> inventory-api).
// Deliberately self-contained: it reuses the argon2 password helpers and
// node:crypto only, with no DB/Redis coupling, so inventory-api can import it
// via `@rop/auth/crew` without pulling in the KDS database client.

export const CREW_SESSION_COOKIE_NAME = "yr_crew_session";

export function hashPin(pin: string): Promise<string> {
  return hashPassword(pin);
}

export function verifyPin(pin: string, hashed: string): Promise<boolean> {
  return verifyPassword(pin, hashed);
}

// Deterministic, keyed lookup index for a PIN. PIN-only login has no username, so
// the API uses this to find the candidate employee in O(1), then verifies the
// argon2 hash. Keyed with a pepper so reading the DB doesn't let an attacker
// brute-force the small 6-digit space offline. The pepper MUST differ from the
// secret passed to signCrewSession.
export function pinLookupHash(pin: string, pepper: string): string {
  return createHmac("sha256", pepper).update(`pin:${pin}`).digest("base64url");
}

export interface CrewSessionPayload {
  employeeId: string;
  name: string;
  /** Expiry as epoch milliseconds. */
  exp: number;
}

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

// Stateless, HMAC-signed session token ("<payload>.<sig>"). No server-side
// session store: the floor app is single-task and short-lived, and revocation
// happens by expiry. Keep the secret out of logs and rotate it to invalidate
// all crew sessions at once.
export function signCrewSession(payload: CrewSessionPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body, secret)}`;
}

export function verifyCrewSession(token: string, secret: string): CrewSessionPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) {
    return null;
  }
  const [body, providedSig] = parts;
  if (body === undefined || providedSig === undefined) {
    return null;
  }

  const expectedSig = sign(body, secret);
  const providedBuf = Buffer.from(providedSig, "base64url");
  const expectedBuf = Buffer.from(expectedSig, "base64url");
  if (providedBuf.length !== expectedBuf.length || !timingSafeEqual(providedBuf, expectedBuf)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as CrewSessionPayload;
    if (
      typeof payload.employeeId !== "string" ||
      typeof payload.name !== "string" ||
      typeof payload.exp !== "number" ||
      payload.exp < Date.now()
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}
