import type { InventoryDataset, InventoryItemAlias } from "@rop/contracts";
// Import the matcher from the leaf subpath, NOT the package barrel: pulling a value from
// the `@rop/contracts` barrel into this module (which is in the global floating-AI
// chunk) dragged the whole contracts graph into that chunk and tripped a latent Turbopack
// minifier TDZ in a shared luxon chunk during `/admin/board` prerender. The `/match`
// subpath is a leaf with no runtime imports, so the chunk graph is unaffected.
import { resolveLearnedAlias, singularizeToken } from "@rop/contracts/match";

// Sentinel `match` value meaning "inline-create a new catalog item from this
// parsed description" (vs. an existing item id). Shared by the receive intake
// sheet and the AI assistant's receipt batch card so both speak the same shape.
export const NEW_ITEM_MATCH = "__new__";

type InventoryItems = InventoryDataset["items"];

// Optional matching context (ADR-0586): the learned aliases to consult, the
// invoice vendor (scopes the alias lookup), and the model's clean canonical-name guess
// (a better fuzzy target than the raw printed line). All optional so legacy callers and
// tests that pass only (description, items) keep working.
export interface MatchContext {
  aliases?: readonly InventoryItemAlias[];
  vendor?: string;
  canonicalName?: string;
}

// Normalize free text for fuzzy matching: lowercase, drop punctuation, collapse space, and
// fold each word to a naive singular so plural drift ("Strawberries" vs a "STRAWBERRY" line)
// doesn't defeat the match. Applied to both the scanned target and every catalog name, so the
// fold is symmetric (see singularizeToken). Tier 0 (the exact learned alias) is unaffected.
export function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map(singularizeToken)
    .join(" ");
}

// Best catalog match for a parsed receipt line, tiered most-confident first (ADR
// alias-learning D3):
//   0. LEARNED ALIAS — a confirmed receive taught this exact vendor wording before, so
//      reuse it instantly (only when it still points at a live catalog item).
//   1. FUZZY — exact normalized hit, then name containment, then shared tokens, run over
//      the model's clean `canonicalName` when present (e.g. "Milk 12 oz") else the raw
//      printed description.
// Returns "" when there is no signal at all — the operator maps or creates (ADR-0538 D4,
// human-in-the-loop). The model never emits a SKU; resolution is deterministic here.
export function bestCatalogMatch(
  description: string,
  items: InventoryItems,
  ctx: MatchContext = {}
): string {
  const learned = resolveLearnedAlias(description, ctx.aliases ?? [], ctx.vendor);
  if (learned && items.some((item) => item.id === learned)) {
    return learned;
  }

  const target = normalizeForMatch(ctx.canonicalName?.trim() || description);
  if (!target) return "";
  const targetTokens = new Set(target.split(" "));
  let bestId = "";
  let bestScore = 0;
  for (const item of items) {
    const name = normalizeForMatch(item.name);
    if (!name) continue;
    let score: number;
    if (name === target) score = 1000;
    else if (target.includes(name)) score = name.length;
    else if (name.includes(target)) score = target.length;
    else score = name.split(" ").filter((token) => targetTokens.has(token)).length;
    if (score > bestScore) {
      bestScore = score;
      bestId = item.id;
    }
  }
  return bestScore > 0 ? bestId : "";
}
