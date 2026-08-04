// Phone is the single customer-identity key (ADR-0024), so normalization must be
// the one chokepoint and rock-solid before launch. This is a US-centric
// best-effort normalizer: it accepts an already-valid E.164 string, a bare
// 10-digit US number (-> +1...), or an 11-digit 1-prefixed US number. Anything
// it can't confidently canonicalize returns null and the route rejects it (400),
// rather than silently creating a mis-keyed customer.
//
// TODO(owner-tunable): if you take international numbers, swap this for a real
// libphonenumber pass. Keep the "reject when unsure" stance — a wrong merge of
// two customers is worse than asking the customer to re-enter.
export function normalizeE164(raw: string): string | null {
  const trimmed = raw.trim();
  if (/^\+[1-9]\d{7,14}$/.test(trimmed)) {
    return trimmed; // already valid E.164
  }
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) {
    return `+1${digits}`; // bare US 10-digit
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`; // US with country code, missing the +
  }
  return null;
}
