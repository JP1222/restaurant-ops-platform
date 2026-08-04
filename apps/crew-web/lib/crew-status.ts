import type { InventoryItem } from "@rop/contracts";

import type { StringKey } from "./strings";

// Client-derived stock health. inventory-api keeps `on_hand` + `flagged_86`
// authoritative but leaves the ok/low/critical *status* a client value (see
// inventory-api AGENTS.md). The bands MUST match backoffice's canonical
// `statusOf` (apps/backoffice-web/lib/inventory/helpers.ts) so the floor and the
// manager agree on what "Low" means — they're the same logic in two apps until
// it's hoisted into packages/contracts:
//   critical : 86'd, empty, or below HALF its min par   (statusOf "critical")
//   low      : below its min par (the reorder point)     (statusOf "low")
//   healthy  : at/above par, or no par set               (statusOf "ok"/"over")
// The earlier crew version used `par_min * 0.5` as the LOW threshold, which is
// actually backoffice's CRITICAL threshold — so anything between half-par and par
// wrongly read "healthy" and the Low band never showed. (The floor has no "over"
// status; overstock just folds into healthy.) An item with par_min === 0 has no
// reorder point, so it can only be critical-when-empty or healthy — set a Min par
// in the item editor to make Low reachable.
export type CrewStatus = "critical" | "low" | "healthy";

export function crewStatus(item: Pick<InventoryItem, "flagged_86" | "on_hand" | "par_min">): CrewStatus {
  if (item.flagged_86 || item.on_hand <= 0 || item.on_hand < item.par_min * 0.5) return "critical";
  if (item.on_hand < item.par_min) return "low";
  return "healthy";
}

// Pill / chip presentation per status. `labelKey` resolves through STRINGS so the
// label stays bilingual; `color` is the foreground, `soft` the tinted background —
// the design tokens (critical #dc2626 / low #c2410c / healthy #1F8A5B on soft tints).
export const CREW_STATUS: Record<CrewStatus, { labelKey: StringKey; color: string; soft: string }> = {
  critical: { labelKey: "it_status_critical", color: "#dc2626", soft: "#fde7e6" },
  low: { labelKey: "it_status_low", color: "#c2410c", soft: "#fbebd8" },
  healthy: { labelKey: "it_status_ok", color: "#1F8A5B", soft: "#e7f6ee" },
};

// Cents → "$X.XX". Money is stored/handled in cents across the suite (per-usage
// cost_cents can be sub-cent, so this is display-only rounding).
export function money(cents: number): string {
  return "$" + (cents / 100).toFixed(2);
}
