/**
 * Numeric guardrail for AI answers (ADR-0030, Phase 0b-3b).
 *
 * Post-hoc and NON-blocking: after a streamed answer finishes, we check that the
 * reportable figures the assistant STATED trace to a number the tools actually
 * returned this turn. Unsourced figures are flagged (telemetry + persisted on
 * the message) so the UI can badge them — we never block or rewrite the stream
 * (that would break streaming UX; this is the "stream + post-hoc annotation"
 * option chosen for 0b-3b).
 *
 * Best-effort sourcing, deliberately conservative to avoid crying wolf:
 *   - We only scrutinize numbers that LOOK like reported KPIs — currency
 *     ($amounts), percentages, or comma-grouped figures. Bare small integers
 *     ("last 7 days", "top 5", "3x") are NOT claims and are left alone.
 *   - We match leniently: a claim is "sourced" if it ≈ a tool number, that
 *     number / 100, or × 100 — covering cents↔dollars and ratio↔percent, in
 *     either direction, within a 1% (or tiny-absolute) tolerance.
 *
 * Tuning lever: widen CLAIM_RE / loosen `approxEqual` to flag less; tighten to
 * flag more. The current defaults bias toward few false alarms.
 */

export interface UnverifiedFigure {
  /** The figure as written in the answer, e.g. "$1,240.50" or "12.3%". */
  text: string;
  /** Parsed numeric value (currency/percent symbols and separators stripped). */
  value: number;
}

// Currency ($1,234.56 / $5), percent (12.3%), or bare comma-grouped (1,234.56).
// Bare ungrouped integers/decimals are intentionally NOT matched — too noisy.
const CLAIM_RE = /\$\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?%|\d{1,3}(?:,\d{3})+(?:\.\d+)?/g;
const SOURCE_NUMBER_RE = /-?\d[\d,]*(?:\.\d+)?/g;

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function toNumber(raw: string): number | null {
  const cleaned = raw.replace(/[$,%\s]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function approxEqual(a: number, b: number): boolean {
  const diff = Math.abs(a - b);
  if (diff <= 0.005) return true; // tiny absolute — cents, ratios
  return diff <= Math.max(Math.abs(a), Math.abs(b)) * 0.01; // 1% relative
}

/** Every numeric token the tools returned this turn (commas stripped). */
function collectSourceNumbers(toolResults: unknown): number[] {
  const json = safeStringify(toolResults);
  const numbers: number[] = [];
  for (const match of json.matchAll(SOURCE_NUMBER_RE)) {
    const n = Number(match[0].replace(/,/g, ""));
    if (Number.isFinite(n)) numbers.push(n);
  }
  return numbers;
}

function isSourced(value: number, sources: number[]): boolean {
  return sources.some(
    (s) => approxEqual(value, s) || approxEqual(value, s / 100) || approxEqual(value, s * 100),
  );
}

/**
 * Reportable figures in `answer` that cannot be traced to any number in the
 * tool results. Empty when everything traces (or there were no claims).
 */
export function findUnverifiedFigures(answer: string, toolResults: unknown): UnverifiedFigure[] {
  if (!answer) return [];
  const sources = collectSourceNumbers(toolResults);

  const flagged: UnverifiedFigure[] = [];
  const seen = new Set<string>();
  for (const match of answer.matchAll(CLAIM_RE)) {
    const text = match[0].trim();
    if (seen.has(text)) continue;
    seen.add(text);
    const value = toNumber(text);
    if (value === null) continue;
    if (!isSourced(value, sources)) {
      flagged.push({ text, value });
    }
  }
  return flagged;
}
