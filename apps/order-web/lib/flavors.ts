import type { FlavorKey } from "./types";

/**
 * Per-flavor radial-gradient palette used by <ProductPhoto/> when a real
 * product photo isn't available. Each entry is a (c1, c2) pair — c1 the
 * highlight, c2 the deeper edge.
 */
export const FLAVOR_PALETTE: Record<FlavorKey, { c1: string; c2: string }> = {
  oreo: { c1: "#F4ECDF", c2: "#EAD4B0" },
  strawberry: { c1: "#FFD4DD", c2: "#F8848F" },
  chocolate: { c1: "#7A4A2E", c2: "#4A2A18" },
  mango: { c1: "#FFE08A", c2: "#FFB13C" },
  "M&M": { c1: "#FFDFE7", c2: "#F4A6BD" },
  condensed: { c1: "#FFF6E0", c2: "#F6E4B0" },
  taro: { c1: "#E8D7F0", c2: "#B98DC9" },
  matcha: { c1: "#DAEAB0", c2: "#A6CE39" },
  coconut: { c1: "#FFF4E8", c2: "#E8D2B5" },
  thai: { c1: "#FFD9A8", c2: "#E89858" },
  milk: { c1: "#F7EDD6", c2: "#D9C49A" },
  jasmine: { c1: "#F5F4D6", c2: "#D6D790" },
  blueberry: { c1: "#D7DEFF", c2: "#7A8BD8" },
  lychee: { c1: "#FFE4EB", c2: "#F4B5C4" },
  honeydew: { c1: "#E3F5C8", c2: "#A8D770" },
  vanilla: { c1: "#FFF8E5", c2: "#F2DFA7" },
};

/** Build the inline `background` value for a flavor swatch. */
export function flavorGradient(flavor: FlavorKey | undefined): string {
  const f = (flavor && FLAVOR_PALETTE[flavor]) || FLAVOR_PALETTE.oreo;
  return `radial-gradient(circle at 30% 30%, ${f.c1}, ${f.c2})`;
}

/**
 * Soft pastel background used to tint a ProductCard so the card silently
 * telegraphs its base flavor. Fades toward near-white at the bottom so
 * price / caption text stays readable.
 */
export function flavorCardBg(flavor: FlavorKey | undefined): string {
  const f = (flavor && FLAVOR_PALETTE[flavor]) || FLAVOR_PALETTE.oreo;
  return `linear-gradient(180deg, ${f.c1}CC 0%, ${f.c1}66 55%, #ffffffEE 100%)`;
}

/**
 * Heuristic — when the menu doesn't carry a `flavor` field, infer one from
 * the item name so we still get the right gradient swatch. Fallback to
 * "oreo" (warm cream) if nothing matches.
 */
export function inferFlavor(name: string): FlavorKey {
  const lc = name.toLowerCase();
  const pairs: Array<[RegExp, FlavorKey]> = [
    [/oreo|cookies?\s*&?\s*cream/, "oreo"],
    [/strawberry|shortcake/, "strawberry"],
    [/chocolate|cocoa|brownie/, "chocolate"],
    [/mango/, "mango"],
    [/m&m|rainbow/, "M&M"],
    [/condensed|cheesecake/, "condensed"],
    [/taro/, "taro"],
    [/matcha|green tea/, "matcha"],
    [/coconut/, "coconut"],
    [/thai/, "thai"],
    [/milk tea|milk$/, "milk"],
    [/jasmine/, "jasmine"],
    [/blueberry/, "blueberry"],
    [/lychee/, "lychee"],
    [/honeydew/, "honeydew"],
    [/vanilla/, "vanilla"],
  ];
  for (const [re, key] of pairs) if (re.test(lc)) return key;
  return "oreo";
}
