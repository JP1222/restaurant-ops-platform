/**
 * Adapter: real (sparse) kds-api menu data → the rich view model the Berry
 * design renders. The live catalog has no badges/tints/calories/flavor-colors
 * and no per-group control hints, so we DERIVE them and degrade gracefully:
 * a card with no tag shows no badge, a group with min/max 1 becomes a radio,
 * etc. Keeps every screen component clean of this heuristic.
 */
import type { FlavorKey, MenuItem, Modifier, ModifierGroup } from "./types";
import { inferFlavor } from "./flavors";

export type ItemKind = "rolled" | "bubble" | "smoothie";

/** Solid fill for the stylized RollCup / BobaCup preview, per flavor. */
export const FLAVOR_COLOR: Record<FlavorKey, string> = {
  oreo: "#E9E4DC",
  strawberry: "#F6A7C0",
  chocolate: "#8A5A3B",
  mango: "#FBC04B",
  "M&M": "#F1D7A0",
  condensed: "#F4E2BE",
  taro: "#C7AEE0",
  matcha: "#A9C97E",
  coconut: "#F4EFE6",
  thai: "#E6915A",
  milk: "#F3E7D2",
  jasmine: "#EAD98F",
  blueberry: "#8C8CD6",
  lychee: "#F3D7DE",
  honeydew: "#BFE39B",
  vanilla: "#FBEFD2",
};

const DEFAULT_CUP = "#FBEFD2";

/** Tints cycled across menu-item photos for a varied, candy look. */
const TINTS = ["tint-pink", "tint-peach", "tint-mint", "tint-lemon", "tint-sky"] as const;

export function tintForIndex(i: number): string {
  return TINTS[i % TINTS.length] ?? "tint-pink";
}

export function itemKind(category: string): ItemKind {
  const c = category.toLowerCase();
  if (c.includes("smoothie")) return "smoothie";
  if (c.includes("tea") || c.includes("boba") || c.includes("bubble") || c.includes("drink")) return "bubble";
  return "rolled";
}

/** Resolve a flavor color from a free-text name (modifier or item). */
export function flavorColorFromName(name: string | undefined): string {
  if (!name) return DEFAULT_CUP;
  const key = inferFlavor(name);
  return (key && FLAVOR_COLOR[key]) || DEFAULT_CUP;
}

/** Deterministic, appetizing dot color for an arbitrary topping name. */
export function toppingColorFromName(name: string): string {
  const palette = ["#E5495B", "#6B4429", "#F6A91E", "#3A2A22", "#C24D8A", "#5BA46F", "#8C8CD6", "#E0A455"];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return palette[h % palette.length] ?? "#E5495B";
}

export type Badge = { t: string; c: string };

/** First tag → a rotated sticker badge. */
export function badgeFromTags(tags: string[] | undefined): Badge | null {
  const first = tags?.[0];
  if (!first) return null;
  const tag = first.toUpperCase();
  const cls =
    /NEW/.test(tag) ? "badge-new" : /HOT|SPIC/.test(tag) ? "badge-hot" : /LIMIT|SEASON/.test(tag) ? "badge-lim" : "badge-top";
  const label = /BEST ?SELLER|FAN ?FAV|POPULAR|TOP/.test(tag) ? "★ Top" : first;
  return { t: label, c: cls };
}

export type GroupControl = {
  kind: "single" | "multi";
  layout: "swatch" | "pill" | "row";
  required: boolean;
  max: number;
  rule: string;
};

/** Derive a control type + layout + human rule from a kds-api ModifierGroup. */
export function groupControl(group: ModifierGroup): GroupControl {
  const single = group.maxSelections <= 1;
  const required = group.minSelections >= 1;
  const isFlavor = /flavor|base/i.test(group.name);
  const layout: GroupControl["layout"] = single ? (isFlavor ? "swatch" : "pill") : "row";
  const rule = single
    ? required
      ? "Required"
      : "Optional"
    : required
      ? `Pick ${group.minSelections}–${group.maxSelections}`
      : `Up to ${group.maxSelections}`;
  return { kind: single ? "single" : "multi", layout, required, max: group.maxSelections, rule };
}

/** Is this group the base/flavor group (drives the preview color)? */
export function isFlavorGroup(group: ModifierGroup): boolean {
  return /flavor|base/i.test(group.name);
}

/** Is this group a topping-ish group (its picks scatter dots on the preview)? */
export function isToppingGroup(group: ModifierGroup): boolean {
  return /top|mix|add|drizzle|sauce|pearl|boba/i.test(group.name);
}

/** Cup color for an item with no selection yet (menu card glyph). */
export function itemCupColor(item: MenuItem): string {
  if (item.flavor && FLAVOR_COLOR[item.flavor]) return FLAVOR_COLOR[item.flavor];
  return flavorColorFromName(item.name);
}

/** Flatten the current builder selection into the flat Modifier[] the cart
 *  store expects (id, name, priceDelta, group). */
export function selectedModifiers(item: MenuItem, sel: Record<string, string | string[]>): Modifier[] {
  const out: Modifier[] = [];
  for (const g of item.modifierGroups) {
    const v = sel[g.id];
    const ids = Array.isArray(v) ? v : v ? [v] : [];
    for (const id of ids) {
      const m = g.modifiers.find((mm) => mm.id === id);
      if (m) out.push(m);
    }
  }
  return out;
}
