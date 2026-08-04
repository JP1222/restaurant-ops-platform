const SENSITIVE_KEY_PATTERN = /(^|_)(token|secret|password|authorization|authcode|auth_code|cardnumber|card_number|pan|last4|first6|first6digit|first_6|bin|expiration|expirationdate|expiration_date|expiry|cardholder|cardholdername|cardholder_name|accountnumber|account_number|routingnumber|routing_number|iban|pin|track1|track2|cvv|signature)$/i;

export function sanitizeCloverPayload<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeCloverPayload(entry)) as T;
  }

  if (typeof value !== "object" || value === null) {
    return value;
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      continue;
    }
    sanitized[key] = sanitizeCloverPayload(child);
  }
  return sanitized as T;
}
