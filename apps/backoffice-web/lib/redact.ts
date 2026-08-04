// Strips secrets/tokens out of free-form strings before they reach a log line
// (audit-2026-05-27 #157). Upstream errors from analytics-api / kds-api can
// echo a 5xx body containing a bearer token, a DB/Redis connection string, or a
// long credential blob; redact those shapes so they never land in Loki.
//
// Kept local to backoffice-web and dependency-free on purpose: it is a tiny
// pure-string utility, and analytics-api keeps its own copy (the two are
// separate apps with separate log pipelines — Iron Law boundaries mean we don't
// reach across app code).

const REDACTED = "[REDACTED]";

const PATTERNS: RegExp[] = [
  // `Bearer <token>` / `Authorization: Bearer <token>`
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  // postgres:// and redis:// connection URIs (with optional credentials)
  /\b(?:postgres(?:ql)?|redis|rediss):\/\/\S+/gi,
  // Long base64-ish credential blobs (API keys, tokens) — 32+ chars.
  /\b[A-Za-z0-9+/_-]{32,}={0,2}\b/g
];

export function redactSecrets(message: string): string {
  let result = message;
  for (const pattern of PATTERNS) {
    result = result.replace(pattern, REDACTED);
  }
  return result;
}
