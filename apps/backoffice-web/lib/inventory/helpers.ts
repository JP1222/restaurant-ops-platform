import type { InventoryItem, InventoryItemStatus } from "@rop/contracts";

export const STATUS_LABEL: Record<InventoryItemStatus, string> = {
  ok: "Healthy",
  low: "Low",
  critical: "Critical",
  over: "Overstock",
  "86": "86'd"
};

export type StatusBadgeTone = "accent" | "warn" | "danger" | "info" | "eightysix";

export const STATUS_TONE: Record<InventoryItemStatus, StatusBadgeTone> = {
  ok: "accent",
  low: "warn",
  critical: "danger",
  over: "info",
  "86": "eightysix"
};

export function statusOf(item: InventoryItem): InventoryItemStatus {
  if (item.flagged_86) return "86";
  if (item.on_hand < item.par_min * 0.5) return "critical";
  if (item.on_hand < item.par_min) return "low";
  // par_max === 0 is the "no upper bound set" sentinel (floor-created items leave it
  // optional) — only flag overstock when a real ceiling exists, else every such item
  // would read "over" the moment it clears par_min. See InventoryItemSchema.par_max.
  if (item.par_max > 0 && item.on_hand > item.par_max) return "over";
  return "ok";
}

export function formatCentsCompact(cents: number): string {
  const v = cents / 100;
  if (Math.abs(v) >= 1000) return `$${(v / 1000).toFixed(1)}k`;
  return `$${v.toFixed(2)}`;
}

export function formatRatePct(rate01: number, fractionDigits = 0): string {
  return `${(rate01 * 100).toFixed(fractionDigits)}%`;
}
