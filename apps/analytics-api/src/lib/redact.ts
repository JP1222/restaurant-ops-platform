// Strips secrets/tokens out of free-form strings before they reach a log line
// (audit-2026-05-27 #157). Upstream errors (pg, fetch, Clover) can echo a
// bearer token, a DB/Redis connection string, or a long credential blob in
// their `.message`; redact those shapes so they never land in Loki.
//
// Kept dependency-free and local to the app on purpose (matches the
// minimal-deps posture of analytics-api). The structured logger in `log.ts`
// runs every message through this, so callers get redaction for free.

const REDACTED = "[REDACTED]";

const PATTERNS: RegExp[] = [
  // `Bearer <token>` / `Authorization: Bearer <token>`
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  // postgres:// and redis:// connection URIs (with optional credentials)
  /\b(?:postgres(?:ql)?|redis|rediss):\/\/\S+/gi,
  // Long base64-ish credential blobs (API keys, tokens) — 32+ chars.
  // Anchored on word boundaries so we don't chew through ordinary prose.
  /\b[A-Za-z0-9+/_-]{32,}={0,2}\b/g
];

export function redactSecrets(message: string): string {
  let result = message;
  for (const pattern of PATTERNS) {
    result = result.replace(pattern, REDACTED);
  }
  return result;
}
