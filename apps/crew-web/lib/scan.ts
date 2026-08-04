import type {
  InventoryItem,
  InventoryItemAlias,
  InventoryReceiptParseResult
} from "@rop/contracts";
// Leaf subpath, not the package barrel — keeps the contracts module graph out of the
// client chunk (see the same note in backoffice's receipt-match.ts).
import { resolveLearnedAlias, singularizeToken } from "@rop/contracts/match";

// One row in the scan review table. The OCR gives `raw` / `qty` / `unit` /
// `priceCents`; `matchId` is the DETERMINISTIC client-side mapping to a catalog
// item (ADR-0538 D3 — the model never emits SKUs). `matchId === null` is an
// unrecognized line that becomes a new-SKU form in the review screen.
// `canonicalName` / `brand` / `pack` are the model's optional clean normalization
// (ADR-0586 D4): the canonical name pre-fills a new item, and raw + brand
// + pack are sent on receive so a confirmed line teaches the vendor alias.
// `fromMemory` is true when the match came from a learned alias (a "remembered" hint).
export interface ScanReviewRow {
  raw: string;
  qty: number;
  unit: string;
  priceCents: number;
  matchId: string | null;
  canonicalName: string;
  brand: string;
  pack: string;
  fromMemory: boolean;
}

// Strip to comparable tokens: lowercase, drop everything but a-z0-9.
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3)
    .map(singularizeToken); // fold plurals so "bananas" overlaps a "Banana" item (symmetric both sides)
}

// Resolve one OCR line to a catalog item id, or null. Tiered, most confident first
// (ADR-0586 D3): (0) a LEARNED ALIAS — a confirmed receive taught this exact
// vendor wording before, so reuse it instantly; then the existing fuzzy passes over the
// model's clean `canonicalName` when present (else the raw description): (1) whole-name /
// sku substring containment, preferring the longest matched name so "matcha powder" beats
// "matcha"; (2) token overlap, so "LECHE ENTERA GAL" still finds "Leche entera" when the
// units differ. Never guesses across a single weak token — an ambiguous line is left
// unmatched (a new-SKU row the operator resolves) rather than mis-routed.
export function matchDescription(
  description: string,
  items: InventoryItem[],
  aliases: readonly InventoryItemAlias[] = [],
  vendor?: string,
  canonicalName?: string
): string | null {
  const learned = resolveLearnedAlias(description, aliases, vendor);
  if (learned && items.some((it) => it.id === learned)) {
    return learned;
  }

  const subject = canonicalName?.trim() || description;
  const descRaw = normalize(subject);
  if (!descRaw) return null;
  // Fold the name-containment comparison so plural drift folds out (strawberry vs
  // strawberries); the SKU tier stays on the raw form — SKUs are codes, not plurals.
  const descNorm = singularizeToken(descRaw);

  let best: { id: string; score: number } | null = null;
  for (const it of items) {
    const nameNorm = singularizeToken(normalize(it.name));
    const skuNorm = normalize(it.sku);
    if (nameNorm && (descNorm.includes(nameNorm) || nameNorm.includes(descNorm))) {
      const score = 1000 + nameNorm.length;
      if (!best || score > best.score) best = { id: it.id, score };
    } else if (skuNorm && descRaw.includes(skuNorm)) {
      const score = 500 + skuNorm.length;
      if (!best || score > best.score) best = { id: it.id, score };
    }
  }
  if (best) return best.id;

  const descTokens = new Set(tokens(subject));
  for (const it of items) {
    const overlap = tokens(it.name).filter((t) => descTokens.has(t)).length;
    if (overlap > 0) {
      const score = overlap;
      if (!best || score > best.score) best = { id: it.id, score };
    }
  }
  return best ? best.id : null;
}

// Turn a parse result into review rows. Price falls back to the matched item's
// stored cost when the invoice price is illegible, so an existing-item line still
// shows a sensible default the operator can correct. Aliases (+ the invoice vendor)
// feed the learned-memory match tier.
export function matchReceiptLines(
  parse: InventoryReceiptParseResult,
  items: InventoryItem[],
  aliases: readonly InventoryItemAlias[] = []
): ScanReviewRow[] {
  return parse.lines.map((line) => {
    const learned = resolveLearnedAlias(line.description, aliases, parse.vendor);
    const matchId = matchDescription(
      line.description,
      items,
      aliases,
      parse.vendor,
      line.canonical_name
    );
    const matched = matchId ? items.find((it) => it.id === matchId) : null;
    return {
      raw: line.description,
      qty: line.qty,
      unit: line.unit ?? matched?.unit ?? "each",
      priceCents: line.unit_price_cents ?? matched?.cost_cents ?? 0,
      matchId,
      canonicalName: line.canonical_name?.trim() ?? "",
      brand: line.brand?.trim() ?? "",
      pack: line.pack?.trim() ?? "",
      fromMemory: Boolean(learned) && matchId === learned
    };
  });
}
