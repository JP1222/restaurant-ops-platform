// Sentry beforeSend helper shared by all Example Kitchen apps that send events to
// sentry.io. Redacts restaurant PII (customer name/phone/notes), provider
// tokens (Clover, Deliverect, Square), session secrets, and auth-bearing request
// headers before the event leaves the process.
//
// Used by every app's Sentry init via:
//   Sentry.init({ ..., beforeSend: (event) => scrubEvent(event) })

const REDACTED_KEYS: ReadonlySet<string> = new Set([
  "customerName",
  "customerPhone",
  "customerEmail",
  "customerNotes",
  "customer_name",
  "customer_phone",
  "customer_email",
  "customer_notes",
  "phoneNumber",
  "phone_number",
  "cloverToken",
  "clover_token",
  "deliverectToken",
  "deliverect_token",
  "deliverectWebhookSecret",
  "deliverect_webhook_secret",
  "squareAccessToken",
  "square_access_token",
  "accessToken",
  "access_token",
  "sessionSecret",
  "session_secret",
  "kdsInternalAdminToken",
  "kds_internal_admin_token",
  "aiTokenEncryptionKey",
  "ai_token_encryption_key",
  "databaseUrl",
  "DATABASE_URL",
  "redisUrl",
  "REDIS_URL",
  "password",
  "passwordHash",
  "password_hash",
]);

const REDACTED_HEADER_RE = /^(authorization|cookie|set-cookie|x-.*-token|x-.*-secret)$/i;

const REDACTED_MARKER = "[redacted]";

// Substring redaction for secret-SHAPED values that key-name matching can't
// reach: a thrown error's message, a query string, or a value stored under an
// innocuous key. Tight patterns only, so the false-positive surface is
// negligible:
//   - 32-byte hex (64 chars): AES master keys (e.g. AI_TOKEN_ENCRYPTION_KEY) and
//     hex tokens. The 2026-06-18 crypto throw is exactly where such a value could
//     land in an exception message.
//   - Postgres/Redis connection-string credentials: redact the `user[:pass]@`
//     between scheme and host, keeping scheme + host for debugging.
const SECRET_VALUE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b[0-9a-fA-F]{64}\b/g, REDACTED_MARKER],
  [/\b((?:postgres(?:ql)?|rediss?):\/\/)[^\s/@]+@/gi, `$1${REDACTED_MARKER}@`],
];

function scrubSecretsInString(value: string): string {
  let out = value;
  for (const [pattern, replacement] of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

type ObjLike = Record<string, unknown>;

// Sentry's event shapes (ErrorEvent / TransactionEvent / etc.) vary across
// SDK versions and have strict structural types under
// `exactOptionalPropertyTypes: true`. To stay version-stable and avoid
// pulling @sentry/types into this otherwise dependency-free package, we
// accept `E` unconstrained and reach into the well-known fields via a
// loose internal alias. Caller code keeps its own static typing because
// `<E>(event: E): E` preserves the input type at the boundary.
type LooseEvent = {
  request?: {
    cookies?: unknown;
    data?: unknown;
    headers?: Record<string, unknown>;
    query_string?: unknown;
  };
  extra?: ObjLike;
  contexts?: Record<string, ObjLike | undefined>;
  tags?: ObjLike;
  user?: ObjLike;
  message?: unknown;
  exception?: { values?: Array<{ value?: unknown } | undefined> };
};

export function scrubEvent<E>(event: E): E {
  if (!event || typeof event !== "object") {
    return event;
  }
  const e = event as LooseEvent;
  if (e.request) {
    delete e.request.cookies;
    if (e.request.data && typeof e.request.data === "object") {
      e.request.data = scrubObject(e.request.data as ObjLike);
    }
    if (e.request.headers) {
      for (const key of Object.keys(e.request.headers)) {
        if (REDACTED_HEADER_RE.test(key)) {
          e.request.headers[key] = REDACTED_MARKER;
        }
      }
    }
    if (typeof e.request.query_string === "string") {
      e.request.query_string = scrubSecretsInString(e.request.query_string);
    }
  }
  if (e.extra) {
    e.extra = scrubObject(e.extra);
  }
  if (e.contexts) {
    for (const key of Object.keys(e.contexts)) {
      const ctx = e.contexts[key];
      if (ctx && typeof ctx === "object") {
        e.contexts[key] = scrubObject(ctx);
      }
    }
  }
  if (e.tags) {
    e.tags = scrubObject(e.tags);
  }
  if (e.user) {
    delete e.user.email;
    delete e.user.username;
    delete e.user.ip_address;
  }
  // Secret-shaped values in free-form strings the structured passes can't reach:
  // the error message + each exception value (where the 2026-06-18 crypto throw
  // would surface a 64-hex key). String-level replace — never drop the event.
  if (typeof e.message === "string") {
    e.message = scrubSecretsInString(e.message);
  }
  if (e.exception?.values) {
    for (const value of e.exception.values) {
      if (value && typeof value.value === "string") {
        value.value = scrubSecretsInString(value.value);
      }
    }
  }
  return event;
}

function scrubObject(obj: ObjLike): ObjLike {
  const out: ObjLike = {};
  for (const [k, v] of Object.entries(obj)) {
    if (REDACTED_KEYS.has(k)) {
      out[k] = REDACTED_MARKER;
      continue;
    }
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = scrubObject(v as ObjLike);
    } else if (Array.isArray(v)) {
      out[k] = (v as unknown[]).map((item): unknown =>
        item && typeof item === "object" && !Array.isArray(item)
          ? scrubObject(item as ObjLike)
          : typeof item === "string"
            ? scrubSecretsInString(item)
            : item
      );
    } else if (typeof v === "string") {
      out[k] = scrubSecretsInString(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}
