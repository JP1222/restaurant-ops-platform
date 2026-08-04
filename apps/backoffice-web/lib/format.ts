const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const COUNT = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

function normalizeSignedZero(value: number): number {
  return Math.abs(value) < 0.05 ? 0 : value;
}

export function formatCents(cents: number): string {
  return USD.format(cents / 100);
}

// Per-usage ingredient cost in cents — sub-cent precision (a cup is $0.052, a 6000-ct napkin
// case 0.479c each -> $0.0048), so distinct from formatCents (whole money, 2dp). Up to 5
// fraction digits captures sub-cent per-usage costs; Intl emits no trailing zeros beyond the
// value's own digits (0.231 not 0.23100), only padding to the 2-digit minimum ($4.29, $0.50).
const UNIT_USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 5,
});

export function formatUnitCost(cents: number): string {
  return UNIT_USD.format(cents / 100);
}

export function formatCount(n: number): string {
  return COUNT.format(n);
}

export function formatPercent(value: number, fractionDigits = 1): string {
  const normalized = normalizeSignedZero(value);
  const sign = normalized > 0 ? "+" : "";
  return `${sign}${normalized.toFixed(fractionDigits)}%`;
}

export function formatRate(rate01: number, fractionDigits = 1): string {
  return `${(rate01 * 100).toFixed(fractionDigits)}%`;
}
