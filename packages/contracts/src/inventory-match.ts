import type { InventoryCategoryId, InventoryItemAlias, InventoryUnitKind } from "./inventory.js";

// Fold a single lowercase token to a naive English singular so the FUZZY match tier is
// blind to singular/plural drift: a vendor's "STRAWBERRY" should still hit a catalog
// "Strawberries", and "BANANAS" should hit "Banana". Applied symmetrically to BOTH the
// scanned text and the catalog name, so the fold need not be linguistically perfect — only
// CONSISTENT: even a "wrong" fold (hummus -> hummu) collapses identically on both sides and
// so never breaks a match, while two genuinely different food words almost never collide.
// Conservative by length so units/codes survive untouched (oz, ct, lbs, gal). This is a
// match-tier heuristic only — it never touches `normalizeAlias`, the exact stored key.
export function singularizeToken(token: string): string {
  if (token.length <= 3) return token; // oz, ct, lbs, gal, and other short units/codes
  if (token.endsWith("ss")) return token; // glass, dress, press — not a plural
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`; // berries -> berry
  if (/(?:s|x|z|ch|sh)es$/.test(token)) return token.slice(0, -2); // boxes -> box, dishes -> dish
  if (token.endsWith("s")) return token.slice(0, -1); // bananas -> banana, eggs -> egg
  return token;
}

// Shared description normalization for vendor-alias matching (ADR-0586 D5).
// ONE function, imported by inventory-api (which writes the alias key) and BOTH web
// matchers (crew-web + backoffice-web, which read it) so the stored key and the lookup
// key can never diverge across the three codebases (Iron Law 2). This is an EXACT-match
// key (not a token bag — token/fuzzy matching is each app's separate fallback tier), so
// it strips ALL non-alphanumerics rather than keeping spaces: "MEMBER'S MARK MILK 12 OZ",
// "member's mark milk 12oz", and "Members Mark Milk 12-oz" all collapse to
// "membersmarkmilk12oz", making the key robust to spacing/punctuation/apostrophe drift
// between how a vendor prints it and how an operator might type it.
export function normalizeAlias(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// High-confidence "learned memory" tier of description->item resolution (ADR
// alias-learning D3, tier 0). Returns a canonical item id when a confirmed receive has
// taught this exact printed text before, else null (the caller falls back to fuzzy name
// matching). Order, most specific first:
//   1. vendor-scoped exact (vendor, normalized) — the Sam's-Club-specific mapping wins.
//   2. vendor-agnostic: the same printed text mapped under any vendor, when it points to
//      exactly ONE item (unambiguous) — covers a missing/mismatched vendor name.
//   3. ambiguous (same text mapped to different items by different vendors, no vendor hit)
//      -> null, so the operator disambiguates rather than the matcher guessing.
export function resolveLearnedAlias(
  description: string,
  aliases: readonly InventoryItemAlias[],
  vendor?: string
): string | null {
  const normalized = normalizeAlias(description);
  if (!normalized) {
    return null;
  }
  const candidates = aliases.filter((alias) => alias.normalized === normalized);
  if (candidates.length === 0) {
    return null;
  }
  if (vendor) {
    const v = normalizeAlias(vendor);
    const scoped = candidates.find((alias) => alias.vendor === v);
    if (scoped) {
      return scoped.item_id;
    }
  }
  const itemIds = new Set(candidates.map((alias) => alias.item_id));
  return itemIds.size === 1 ? (candidates[0]?.item_id ?? null) : null;
}

// One AI match suggestion for a scanned line (ADR-0586 Phase 2A). Structural (not the
// zod type) so this leaf module stays import-free and client chunks can pull it without
// the contracts barrel (see the receipt-match note).
export interface MatchSuggestionLike {
  index: number;
  item_id: string | null;
  confidence: number;
}

// Decide which AI suggestions to actually apply. A suggestion is accepted only when it
// (1) names a real, still-present catalog item (hallucination guard — the model may echo
// an id outside the candidate set), and (2) clears the confidence threshold. Returns a
// map keyed by line index so the caller can auto-select the matched item and show the
// score; everything else is left for the operator (ADR-0538 D4, human commits).
export function applyMatchSuggestions(
  suggestions: readonly MatchSuggestionLike[],
  validItemIds: ReadonlySet<string>,
  threshold: number
): Map<number, { itemId: string; confidence: number }> {
  const accepted = new Map<number, { itemId: string; confidence: number }>();
  for (const s of suggestions) {
    if (s.item_id && s.confidence >= threshold && validItemIds.has(s.item_id)) {
      accepted.set(s.index, { itemId: s.item_id, confidence: s.confidence });
    }
  }
  return accepted;
}

// One vendor's price for an item, derived from the learned aliases (ADR-0586 Phase 2B).
export interface VendorPrice {
  vendor: string; // display label (raw vendor name), else a prettified normalized key
  lastCostCents: number;
  hits: number;
}

// Structural alias shape (a subset of the InventoryItemAlias DTO) so this leaf stays
// barrel-free for client chunks.
export interface AliasPriceLike {
  item_id: string;
  vendor: string;
  vendor_label: string;
  last_cost_cents: number | null;
  hits: number;
  last_seen_at: string;
}

function prettifyVendorKey(key: string): string {
  return key ? key.charAt(0).toUpperCase() + key.slice(1) : "Unknown";
}

// Per-vendor last price for one item, cheapest first (ADR-0586 Phase 2B). Reads the learned
// aliases the receive flow already captured: one row per vendor — the most-recently-received
// priced wording wins (last_seen_at), so the price reflects what was LAST PAID, not the most
// frequent listing (a newer invoice with different wording must not be shadowed by an older,
// higher-hit one). Aliases without a price are skipped; display name prefers vendor_label.
export function vendorPricesForItem(
  itemId: string,
  aliases: readonly AliasPriceLike[]
): VendorPrice[] {
  const byVendor = new Map<string, AliasPriceLike>();
  for (const a of aliases) {
    if (a.item_id !== itemId || a.last_cost_cents == null) continue;
    const prior = byVendor.get(a.vendor);
    // Latest receive wins; fall back to higher hits only when seen at the same instant.
    if (!prior || a.last_seen_at > prior.last_seen_at || (a.last_seen_at === prior.last_seen_at && a.hits > prior.hits)) {
      byVendor.set(a.vendor, a);
    }
  }
  return [...byVendor.values()]
    .map((a) => ({
      vendor: a.vendor_label.trim() || prettifyVendorKey(a.vendor),
      lastCostCents: a.last_cost_cents as number,
      hits: a.hits
    }))
    .sort((x, y) => x.lastCostCents - y.lastCostCents);
}

// Pack/unit conversion for receiving (ADR-0592). An invoice often prices by a PURCHASE unit
// ("2 cases @ $50") while stock is tracked in a smaller STOCK unit ("each"); receiving the
// printed number straight lands "2 cases" as "2 each". These pure helpers turn an
// operator-confirmed "received as a pack" choice into the stock-unit qty + per-each cost the
// receive API expects. Shared by backoffice + crew (Iron Law 2); the conversion is shown and
// confirmed in the UI before commit, and the server math is unchanged, so a wrong guess can't
// silently corrupt on-hand.
const PACK_UNIT_WORDS = new Set([
  "case", "cases", "cs", "cse",
  "box", "boxes", "bx",
  "carton", "cartons", "ctn", "carts",
  "ct",
  "flat", "flats",
  "pack", "packs", "pk", "pkg",
  "dozen", "doz", "dz",
  "crate", "crates",
  "tray", "trays"
]);

function normUnit(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

// Does this invoice-line unit look like the item's purchase pack (vs its stock unit)? True when
// it matches the item's configured purchase unit, or is a known pack word. each/ea/unit/blank
// are never pack units.
export function looksLikePackUnit(lineUnit: string, purchaseUnit: string): boolean {
  const u = normUnit(lineUnit);
  if (u.length === 0 || u === "each" || u === "ea" || u === "unit" || u === "units") return false;
  const purchase = normUnit(purchaseUnit);
  if (purchase.length > 0 && purchase !== "each" && u === purchase) return true;
  return PACK_UNIT_WORDS.has(u);
}

// Per-usage costs are sub-cent Floats in this system (a 6000-ct napkin case at $28.75 is
// 0.479c each). Round to 4 decimal places of a cent ($0.000001) so a non-terminating
// division never persists as double-precision noise (0.4791666666666667), while keeping far
// more than whole-cent precision (the old Math.round flattened a napkin to 0c). Aggregate
// drift over even a multi-thousand-unit pack stays sub-cent. Display strips trailing zeros
// separately. The whole-cent amounts you PAY (purchase_cost_cents) stay integers; only this
// DERIVED per-usage cost carries decimals.
export function roundCost(cents: number): number {
  return Math.round(cents * 1e4) / 1e4;
}

export interface ReceiveQtyCost {
  qty: number;
  unitCostCents: number | undefined;
}

// Convert an operator-entered qty + per-stated-unit cost into stock-unit qty + per-stock-unit
// cost. When `asPack` (and the item has a real pack > 1), qty is multiplied by the pack size
// and the (then per-pack) cost is divided by it; otherwise it passes through unchanged — so the
// default, and any non-pack item, behaves exactly as before. The per-unit cost keeps sub-cent
// precision (roundCost), not whole cents, so a high-count cheap pack isn't flattened to 0.
export function convertForReceive(
  qty: number,
  costCents: number | undefined,
  packQty: number,
  asPack: boolean
): ReceiveQtyCost {
  const factor = asPack && packQty > 1 ? packQty : 1;
  return {
    qty: qty * factor,
    unitCostCents: costCents == null ? undefined : roundCost(costCents / factor)
  };
}

// ── Duplicate-line merge for receipt receiving (ADR-0538 D4) ──────────────────
// A vendor receipt routinely lists the SAME product on several lines. The vision model
// transcribes each one faithfully (it must — "transcribe only what's printed"), so without
// a merge step every receive surface shows N separate rows for one item and the operator has
// to reconcile them by hand; worse, two unmatched duplicates would inline-create the SAME
// catalog item twice. `mergeReceiptLines` collapses the duplicates BEFORE review, summing qty.

// Structural view of a parsed receipt line — only the fields the merge reads/keys on. The real
// InventoryReceiptParseLine is a superset; declared structurally (like MatchSuggestionLike /
// AliasPriceLike) so this leaf module stays barrel-free for client chunks.
export interface ReceiptLineLike {
  description: string;
  qty: number;
  unit?: string;
  unit_price_cents?: number;
  canonical_name?: string;
}

// The MERGE POLICY: the key two lines must share (exactly, and non-null) to fold together.
// Operator decision (2026-06-13) — CONSERVATIVE: merge only when two lines are the SAME item
// AND the SAME unit AND the SAME unit price. Any difference (a price bump, a "case" vs "each"
// unit) keeps the line a separate, visible row, so a discrepancy is never silently averaged
// into the cost basis — the human still sees every distinct price before it hits the ledger.
//
// `itemId` is the caller's resolved catalog match for this line (its own matcher), or null
// when the line is unmatched / create-new.
export function receiptMergeKey(line: ReceiptLineLike, itemId: string | null): string | null {
  // identity: the catalog item id for a matched line; else the normalized printed text, so two
  // identical create-new lines still fold into ONE new item (receiveAdHoc would otherwise create
  // the same item twice). A line with no id and blank text has no identity → it never merges.
  const identity = itemId ?? (normalizeAlias(line.canonical_name ?? line.description) || null);
  if (identity === null) return null;

  // One canonical key = identity + normalized unit + EXACT cents. Two lines collide (and merge)
  // only when all three match; a price bump or a "case" vs "each" unit yields a different key, so
  // that line stays a separate, visible row. "|" can't appear inside any part, so distinct fields
  // never collide ("milk|12|300" can't be reached two ways). Empty unit/price are their own bucket.
  return `${identity}|${normUnit(line.unit ?? "")}|${line.unit_price_cents ?? ""}`;
}

// One collapsed group: the result line (first occurrence's fields, qty = the group's sum).
export interface ReceiptMergeResult<T extends ReceiptLineLike> {
  /** The merged lines, order-preserved (each group anchored at its first occurrence). */
  lines: T[];
  /** How many input lines folded away (lines.length shrank by this). 0 = nothing merged. */
  mergedCount: number;
}

// Collapse duplicate receipt lines per `receiptMergeKey`, summing qty into the FIRST occurrence
// (its description / price / unit / brand / pack are kept; only its qty grows). Order is
// preserved. `resolvedItemIds` is the caller's per-line catalog match (from its own matcher),
// parallel to `lines`; pass null where a line is unmatched / create-new. Pure + generic so all
// three receive surfaces (backoffice intake, backoffice AI card, crew scan) share ONE tested
// decision (Iron Law 2). The input array and its elements are never mutated.
export function mergeReceiptLines<T extends ReceiptLineLike>(
  lines: readonly T[],
  resolvedItemIds: readonly (string | null)[]
): ReceiptMergeResult<T> {
  const merged: T[] = [];
  const byKey = new Map<string, T>();
  for (const [index, line] of lines.entries()) {
    const key = receiptMergeKey(line, resolvedItemIds[index] ?? null);
    const prior = key === null ? undefined : byKey.get(key);
    if (prior) {
      prior.qty += line.qty;
      continue;
    }
    const copy = { ...line } as T;
    merged.push(copy);
    if (key !== null) byKey.set(key, copy);
  }
  return { lines: merged, mergedCount: lines.length - merged.length };
}

// ── Size parsing + family grouping for the scan → one-item-many-packs flow ─────────────────────
// (ADR scan-same-product-multi-size). A vendor line prints a SIZE ("28 oz", "1.5 L", "case of
// 24", "4 x 12 oz"); to build an InventoryItemPack from a scan (ADR-0737) we need that size as a
// number + base unit + unit kind. The vision model keeps emitting the free-text `pack`/
// `canonical_name` (it never emits structured catalog data — ADR-0538 D3); we parse the size
// DETERMINISTICALLY here so the result is testable and variance-free. Pure + barrel-free, so all
// three surfaces (crew-web, backoffice-web, inventory-api) share ONE decision (Iron Law 2).

export interface ParsedSize {
  /** Base units one pack of this size holds: "28 oz" -> 28; "4 x 12 oz" -> 48; "case of 24" -> 24. */
  qty: number;
  /** The base (stock) unit the size resolves to — the stable small unit per ADR-0737 D1. */
  unit: string;
  kind: InventoryUnitKind;
}

// Unit patterns, MOST-SPECIFIC FIRST so "fl oz" wins over "oz" and "kg"/"ml" over "g"/"l". `src`
// is a regex alternation matched as a whole word (\b-anchored at the call site); `unit` is the
// canonical base unit we persist. Mirrors off-lookup.ts's UNIT_RULES but returns the qty too.
const SIZE_UNIT_PATTERNS: { src: string; unit: string; kind: InventoryUnitKind }[] = [
  { src: "fl\\.?\\s?oz|fluid\\s?ounces?", unit: "fl oz", kind: "volume" },
  { src: "ounces?|oz", unit: "oz", kind: "weight" },
  { src: "pounds?|lbs?", unit: "lb", kind: "weight" },
  { src: "kilograms?|kgs?", unit: "kg", kind: "weight" },
  { src: "grams?|g", unit: "g", kind: "weight" },
  { src: "milli\\s?lit(?:er|re)s?|mls?", unit: "ml", kind: "volume" },
  { src: "lit(?:er|re)s?|l", unit: "L", kind: "volume" },
  { src: "gallons?|gal", unit: "gal", kind: "volume" },
  { src: "counts?|ct|pcs?|pieces?|packs?|pk|ea|each", unit: "each", kind: "count" }
];

const ALL_SIZE_UNIT_SRC = SIZE_UNIT_PATTERNS.map((u) => u.src).join("|");

// "case of 24" / "box of 12" — a bare count package with no measure unit.
const COUNT_OF_RE = /(?:case|box|carton|pack|bag|tray|flat|crate)\s*of\s*(\d+(?:\.\d+)?)/i;
// A number, an optional "x N" pack multiplier ("4 x 12 oz"), then a size unit as a whole word.
// The `(?<!\d|\/)` guard keeps a fraction's denominator out: "1/2 gal" must NOT parse as "2 gal"
// (the "2" is preceded by "/"), and "12 oz" stays intact (no digit/slash before the "1").
const SIZE_TOKEN_SRC = `(?<![\\d/])(\\d+(?:\\.\\d+)?)\\s*(?:[x×*]\\s*(\\d+(?:\\.\\d+)?)\\s*)?(?:${ALL_SIZE_UNIT_SRC})\\b`;

// Parse the first size token out of free text into { qty, unit, kind }, or null when none is
// legible (cups/straws, an unsized brand name like "Gold Bears"). Fail-soft: a null just means the
// caller falls back to today's flat-item path / an operator-entered pack.
export function parseSizeToken(text: string | null | undefined): ParsedSize | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  for (const u of SIZE_UNIT_PATTERNS) {
    const m = lower.match(new RegExp(`(?<![\\d/])(\\d+(?:\\.\\d+)?)\\s*(?:[x×*]\\s*(\\d+(?:\\.\\d+)?)\\s*)?(?:${u.src})\\b`));
    if (m) {
      const a = Number.parseFloat(m[1] ?? "");
      const b = m[2] != null ? Number.parseFloat(m[2]) : 1;
      const qty = a * b;
      if (Number.isFinite(qty) && qty > 0) {
        return { qty, unit: u.unit, kind: u.kind };
      }
    }
  }
  const c = lower.match(COUNT_OF_RE);
  if (c) {
    const qty = Number.parseFloat(c[1] ?? "");
    if (Number.isFinite(qty) && qty > 0) {
      return { qty, unit: "each", kind: "count" };
    }
  }
  return null;
}

const SIZE_STRIP_RE = new RegExp(SIZE_TOKEN_SRC, "gi");

// Strip every size token from a name so the residue is the bare product. Used only to derive the
// grouping key — never to rename an item.
function stripSizeTokens(text: string): string {
  return text.replace(SIZE_STRIP_RE, " ").replace(COUNT_OF_RE, " ");
}

// The FAMILY KEY for grouping: the product name with its size stripped, lowercased, punctuation
// dropped, and each token folded to a naive singular (singularizeToken). Two lines that are the
// SAME product at different sizes collapse to the same key — "Goldbears 28 oz" and "Gold Bears"
// both -> "goldbear" — so the scan flow can offer them as ONE item with two packs (ADR-0737),
// instead of two duplicate items. Brand is deliberately NOT folded in: the model's brand
// extraction is inconsistent, and including it would cause false NON-matches (the failure that
// actually hurts here). Empty in -> "" (never groups).
export function baseProductKey(line: { canonicalName?: string | null; description?: string | null }): string {
  const raw = line.canonicalName?.trim() || line.description?.trim() || "";
  if (!raw) return "";
  const norm = stripSizeTokens(raw)
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!norm) return "";
  return norm.split(" ").map(singularizeToken).join("");
}

// The human-readable base product NAME — the printed name with its size token removed, case +
// spacing preserved (ADR-882 Phase 4). Used to name a multi-size family's item ("Gummy Bears 28
// Oz" -> "Gummy Bears") so it isn't named after one of its sizes. Empty/size-only -> the trimmed
// input (never empties a name).
export function baseProductName(text: string | null | undefined): string {
  const raw = (text ?? "").trim();
  if (!raw) return "";
  const stripped = stripSizeTokens(raw).replace(/\s+/g, " ").trim();
  return stripped || raw;
}

// Keyword -> category guess for a freshly scanned NEW item (ADR scan-same-product-multi-size D6).
// Tuned for a frozen-dessert shop: candy/gummy/sprinkles/syrups are TOPPINGS (they go on the
// dessert), not "dairy". Rules are tried in order, first whole-word hit wins, and the candy rules
// sit BEFORE the dairy rule so a sweet whose name happens to contain "cream" isn't miscategorised.
// Returns null when nothing matches (the caller defaults to "food" / Other Food, never "dairy").
// Sibling of off-lookup.ts's categoryFromOff (which maps OFF taxonomy tags, a different input).
const TEXT_CATEGORY_RULES: { re: RegExp; id: InventoryCategoryId }[] = [
  { re: /\b(cups?|lids?|straws?|spoons?|forks?|napkins?|containers?|cartons?|to[- ]?go|packaging)\b/, id: "packaging" },
  { re: /\b(cleaners?|sanitizers?|gloves?|towels?|soap|detergent|bleach|sponges?|trash\s?bags?|supplies)\b/, id: "supplies" },
  { re: /\b(gumm(?:y|i|ies)|cand(?:y|ies)|sprinkles?|jimmies|marshmallows?|chocolate\s?chips?|choc\s?chips?|toffee|oreos?|cookie\s?(?:dough|crumbs?|bits?)|brownie|mochi|boba|tapioca|pearls?)\b/, id: "topping" },
  { re: /\b(syrups?|sauces?|toppings?|drizzles?|fudge|ganache|caramel|nutella)\b/, id: "topping" },
  { re: /\b(milk|creams?|creamer|half[- ]?and[- ]?half|yogurts?|yoghurts?|gelato|custard|butter|cheese|dairy)\b/, id: "dairy" },
  { re: /\b(sugars?|sweeteners?|honey|agave|molasses|stevia|monk\s?fruit)\b/, id: "sweetener" },
  { re: /\b(fruits?|strawberr\w*|blueberr\w*|raspberr\w*|blackberr\w*|bananas?|mango(?:es)?|pineapples?|peach(?:es)?|cherr(?:y|ies)|kiwis?|melons?|berr(?:y|ies))\b/, id: "fruit" },
  { re: /\b(powders?|matcha|cocoa|taro|chai|teas?|bases?|mix(?:es)?)\b/, id: "powder" }
];

export function categoryFromText(text: string | null | undefined): InventoryCategoryId | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  for (const rule of TEXT_CATEGORY_RULES) {
    if (rule.re.test(lower)) {
      return rule.id;
    }
  }
  return null;
}

// ── Pack-grouping plan for the scan review (ADR-882 Phase 3) ───────────────────────────────────
// Given the review's parsed lines + each line's catalog match (from the app's own matcher tiers) +
// the catalog, decide how same-product-different-size lines should collapse into the
// one-item-many-packs shape (ADR-0737) on confirm. The output is a SUGGESTION the review UI applies
// as an editable default; the operator still confirms (ADR-0538 D4 — human commits, with a "split"
// escape). Pure + barrel-free so crew-web and backoffice-web share ONE decision (Iron Law 2).

export interface ScanGroupLine {
  index: number;
  /** The app matcher's resolved catalog item id, or null for an unmatched (new) line. */
  matchId: string | null;
  canonicalName?: string | null;
  description?: string | null;
}

export interface ScanGroupResult {
  index: number;
  /** Map this NEW line onto an existing item (its base-product name matched the catalog), else null. */
  targetItemId: string | null;
  /** Shared family ref for >=2 NEW lines that are one product at different sizes, else null. Never set together with targetItemId. */
  itemGroup: string | null;
  /** The printed size parsed into a pack (qty + base unit), or null when none is legible. */
  pack: ParsedSize | null;
}

// Sentinel: a base key two different catalog items share — we never auto-map a line onto an
// ambiguous key (the operator picks), so a wrong size never silently joins the wrong product.
const AMBIGUOUS_ITEM = " ambiguous";

export function planScanGrouping(
  lines: readonly ScanGroupLine[],
  items: readonly { id: string; name: string }[]
): ScanGroupResult[] {
  const itemByKey = new Map<string, string>();
  for (const it of items) {
    const key = baseProductKey({ canonicalName: it.name });
    if (!key) continue;
    itemByKey.set(key, itemByKey.has(key) ? AMBIGUOUS_ITEM : it.id);
  }

  // How many UNMATCHED lines share each base key — a key shared by >=2 new lines forms a family.
  const newKeyCounts = new Map<string, number>();
  for (const line of lines) {
    if (line.matchId) continue;
    const key = baseProductKey(line);
    if (key) newKeyCounts.set(key, (newKeyCounts.get(key) ?? 0) + 1);
  }

  return lines.map((line): ScanGroupResult => {
    const flat: ScanGroupResult = { index: line.index, targetItemId: null, itemGroup: null, pack: null };
    if (line.matchId) return flat; // already mapped by the app matcher — untouched
    const key = baseProductKey(line);
    const pack = parseSizeToken(line.canonicalName?.trim() || line.description?.trim() || null);
    if (!key) return { ...flat, pack };
    const existing = itemByKey.get(key);
    if (existing && existing !== AMBIGUOUS_ITEM) {
      // A new size of an item already in the catalog -> add it onto that item.
      return { ...flat, targetItemId: existing, pack };
    }
    if ((newKeyCounts.get(key) ?? 0) >= 2) {
      // >=2 new lines that are the same product at different sizes -> one new item, many packs.
      return { ...flat, itemGroup: `fam:${key}`, pack };
    }
    // A lone new line: a single new item, optionally carrying its one pack.
    return { ...flat, pack };
  });
}

// ── Cross-unit pack math for the scan review (ADR-882 Phase 4) ─────────────────────────────────
// Grouping different SIZES of one product into one item (ONE base unit, many packs — ADR-0737 D1)
// needs every pack's base_qty in that one base unit: a "5 lb" pack on an oz-based item is 80, not 5.
// parseSizeToken gives (5, lb); these helpers convert within a measurement kind and pick the
// family's base unit so on_hand never mis-converts. Cross-KIND (weight vs volume) returns null —
// uncombinable, so the operator resolves it (ADR-0737 D5, no silent guess).

// Factors to a canonical micro-unit per kind. lb/oz = 16, kg/g = 1000, gal/fl oz = 128, L/ml = 1000
// are exact; oz->g etc. carry decimals (base_qty is a Float column, so that's fine).
const WEIGHT_TO_G: Record<string, number> = { g: 1, oz: 28.349523125, lb: 453.59237, kg: 1000 };
const VOLUME_TO_ML: Record<string, number> = { ml: 1, "fl oz": 29.5735295625, L: 1000, gal: 3785.411784 };

function unitScale(unit: string): { kind: "weight" | "volume" | "count"; factor: number } | null {
  if (unit in WEIGHT_TO_G) return { kind: "weight", factor: WEIGHT_TO_G[unit] as number };
  if (unit in VOLUME_TO_ML) return { kind: "volume", factor: VOLUME_TO_ML[unit] as number };
  if (unit === "each") return { kind: "count", factor: 1 };
  return null;
}

function roundQty(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}

// Convert a parsed size into `targetUnit` (same kind). null when the units are different kinds or
// either is unknown — the caller asks the operator instead of guessing.
export function convertSize(size: ParsedSize, targetUnit: string): number | null {
  if (size.unit === targetUnit) return size.qty;
  const from = unitScale(size.unit);
  const to = unitScale(targetUnit);
  if (!from || !to || from.kind !== to.kind) return null;
  return roundQty(size.qty * (from.factor / to.factor));
}

// The base unit for a family of sizes: the most granular (smallest-factor) unit among them, so the
// pack base_qty values stay clean ("28 oz" + "5 lb" -> base "oz"). null when the sizes span
// different kinds (can't unify) or none is a known unit.
export function chooseFamilyBaseUnit(sizes: readonly ParsedSize[]): string | null {
  const scaled = sizes
    .map((s) => ({ unit: s.unit, scale: unitScale(s.unit) }))
    .filter((x): x is { unit: string; scale: NonNullable<ReturnType<typeof unitScale>> } => x.scale !== null);
  if (scaled.length === 0) return null;
  const kind = scaled[0]!.scale.kind;
  if (!scaled.every((x) => x.scale.kind === kind)) return null;
  return scaled.reduce((best, x) => (x.scale.factor < best.scale.factor ? x : best)).unit;
}

function packLabel(size: ParsedSize): string {
  return `${roundQty(size.qty)} ${size.unit}`;
}

// The full per-line pack plan the review UI applies (ADR-882 Phase 4). Wraps planScanGrouping with
// the cross-unit math: a family resolves to one base unit with each pack's base_qty converted into
// it; a new size of an existing item converts into THAT item's base unit. A line that should carry
// a pack but whose size isn't parseable/convertible is flagged `needsPackInput` so the UI makes the
// operator enter the pack qty (never a silent default). Lone new lines and matched lines stay flat.
export interface ResolvedScanPack {
  index: number;
  targetItemId: string | null;
  itemGroup: string | null;
  /** Base unit a NEW family item is created in (the family's most granular unit), else null. */
  baseUnit: string | null;
  pack: { label: string; baseQtyPerPack: number } | null;
  needsPackInput: boolean;
}

export function resolveScanPacks(
  lines: readonly ScanGroupLine[],
  items: readonly { id: string; name: string; unit: string }[]
): ResolvedScanPack[] {
  const plan = planScanGrouping(lines, items);
  const unitById = new Map(items.map((it) => [it.id, it.unit] as const));

  // Base unit per family = the most granular unit among its members' parsed sizes.
  const familyBaseUnit = new Map<string, string | null>();
  for (const p of plan) {
    if (!p.itemGroup || familyBaseUnit.has(p.itemGroup)) continue;
    const sizes = plan
      .filter((q) => q.itemGroup === p.itemGroup && q.pack)
      .map((q) => q.pack as ParsedSize);
    familyBaseUnit.set(p.itemGroup, chooseFamilyBaseUnit(sizes));
  }

  return plan.map((p): ResolvedScanPack => {
    const flat: ResolvedScanPack = {
      index: p.index,
      targetItemId: p.targetItemId,
      itemGroup: p.itemGroup,
      baseUnit: null,
      pack: null,
      needsPackInput: false
    };
    const size = p.pack;
    if (p.targetItemId) {
      const unit = unitById.get(p.targetItemId) ?? null;
      const qty = unit && size ? convertSize(size, unit) : null;
      return {
        ...flat,
        baseUnit: unit,
        pack: qty != null && size ? { label: packLabel(size), baseQtyPerPack: qty } : null,
        needsPackInput: qty == null
      };
    }
    if (p.itemGroup) {
      const unit = familyBaseUnit.get(p.itemGroup) ?? null;
      const qty = unit && size ? convertSize(size, unit) : null;
      return {
        ...flat,
        baseUnit: unit,
        pack: qty != null && size ? { label: packLabel(size), baseQtyPerPack: qty } : null,
        needsPackInput: qty == null
      };
    }
    // Lone new line (or matched): stay flat — no auto pack (avoids qty-semantics ambiguity).
    return flat;
  });
}

