/**
 * Pure resolvers over a Clover merchant's config, used to build + settle online
 * orders correctly. Defensive (array-or-`elements`, missing fields), mirroring
 * normalize-menu.ts.
 */

type JsonRecord = Record<string, unknown>;

function toElements(raw: unknown): JsonRecord[] {
  const record = raw !== null && typeof raw === "object" ? (raw as JsonRecord) : null;
  const value = record && Array.isArray(record.elements) ? record.elements : raw;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is JsonRecord => entry !== null && typeof entry === "object");
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

// The merchant tender used to record an externally-processed (web) payment.
export const EXTERNAL_PAYMENT_TENDER_LABEL_KEY = "com.clover.tender.external_payment";

/**
 * The taxable order type to reference so Clover applies tax (prefer the default).
 * Returns null when the merchant has no taxable order type — the order is then
 * built without an `orderType` (no tax), which is exactly how a bare sandbox
 * merchant behaves.
 */
export function pickTaxableOrderTypeId(rawOrderTypes: unknown): string | null {
  const taxable = toElements(rawOrderTypes).filter((orderType) => orderType.taxable === true);
  const chosen = taxable.find((orderType) => orderType.isDefault === true) ?? taxable[0] ?? null;
  return chosen ? asString(chosen.id) : null;
}

/**
 * The merchant's "External Payment" tender id — required to record the web
 * charge so the order reaches a PAID state. Returns null if the merchant has no
 * such tender (the checkout then fails closed rather than leaving an unpaid order).
 */
export function pickExternalPaymentTenderId(rawTenders: unknown): string | null {
  const tender = toElements(rawTenders).find(
    (candidate) => asString(candidate.labelKey) === EXTERNAL_PAYMENT_TENDER_LABEL_KEY,
  );
  return tender ? asString(tender.id) : null;
}
