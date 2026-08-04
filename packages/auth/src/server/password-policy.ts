import { createHash } from "node:crypto";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, type PasswordRejectionReason } from "@rop/contracts";

// Password strength per NIST SP 800-63B / OWASP ASVS 5.0 (ADR-0029): length,
// not composition, plus a breach-list screen via Have I Been Pwned's Pwned
// Passwords range API (k-anonymity — only the first 5 SHA-1 hex chars leave
// the box). See ADR-0029 for the policy rationale.
const HIBP_RANGE_URL = "https://api.pwnedpasswords.com/range/";
const HIBP_TIMEOUT_MS = 2500;

export type PasswordStrengthResult =
  | { ok: true }
  | { ok: false; reason: Extract<PasswordRejectionReason, "too_short" | "breached">; message: string };

// Returns true when the password appears in a known breach corpus. Fails OPEN
// (returns false) on network error/timeout: a breach-list outage must never
// block a legitimate password change — the length floor still applies.
async function isBreachedPassword(password: string): Promise<boolean> {
  const sha1 = createHash("sha1").update(password).digest("hex").toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HIBP_TIMEOUT_MS);
  try {
    const response = await fetch(`${HIBP_RANGE_URL}${prefix}`, {
      headers: { "Add-Padding": "true" },
      signal: controller.signal,
    });
    if (!response.ok) {
      return false;
    }
    const body = await response.text();
    for (const line of body.split("\n")) {
      const separator = line.indexOf(":");
      if (separator > 0 && line.slice(0, separator).trim().toUpperCase() === suffix) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function validatePasswordStrength(password: string): Promise<PasswordStrengthResult> {
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    return {
      ok: false,
      reason: "too_short",
      message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    };
  }

  if (await isBreachedPassword(password)) {
    return {
      ok: false,
      reason: "breached",
      message: "This password has appeared in a known data breach. Choose a different one.",
    };
  }

  return { ok: true };
}
