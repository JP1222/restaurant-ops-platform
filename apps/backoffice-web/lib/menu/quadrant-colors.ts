import type { MenuQuadrant } from "@rop/contracts";

export const QUADRANT_COLOR: Record<MenuQuadrant, string> = {
  star: "var(--chart-1)",
  plowhorse: "var(--chart-3)",
  puzzle: "var(--chart-4)",
  dog: "var(--chart-6)"
};

export const QUADRANT_LABEL: Record<MenuQuadrant, string> = {
  star: "Star",
  plowhorse: "Plowhorse",
  puzzle: "Puzzle",
  dog: "Dog"
};

/** Reading order for the matrix legend, action cards, and tables. */
export const QUADRANT_ORDER: MenuQuadrant[] = ["star", "plowhorse", "puzzle", "dog"];

/** What to do about each quadrant — the operator playbook. */
export const QUADRANT_ACTION: Record<MenuQuadrant, string> = {
  star: "Protect. Hold price and keep them prominent on the menu and order screens.",
  plowhorse:
    "Popular but thin. Nudge price up or trim plate cost without hurting demand.",
  puzzle: "Good margin, low pull. Rename, reposition, bundle, or suggestive-sell.",
  dog: "Low margin and low demand. Consider removing or reworking the recipe."
};
