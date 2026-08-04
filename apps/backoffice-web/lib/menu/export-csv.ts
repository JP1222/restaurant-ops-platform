import { QUADRANT_LABEL } from "@/lib/menu/quadrant-colors";
import type { MenuEngineeringView } from "@/lib/menu/kasavana-smith";

const HEADER = [
  "Rank",
  "Item",
  "Quadrant",
  "Units",
  "Revenue",
  "Plate cost",
  "Contribution margin",
  "Margin %"
];

function escapeCell(value: string | number): string {
  const str = String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

/** Pure: serialize the ranked matrix to CSV text (dollars, 2dp). */
export function buildMenuCsv(view: MenuEngineeringView): string {
  const rows = [...view.items]
    .sort((a, b) => a.rank - b.rank)
    .map((item) => [
      item.rank,
      item.item_name,
      QUADRANT_LABEL[item.quadrant],
      item.units,
      (item.revenue_cents / 100).toFixed(2),
      (item.plate_cost_cents / 100).toFixed(2),
      (item.margin_cents / 100).toFixed(2),
      (item.margin_pct * 100).toFixed(1)
    ]);

  return [HEADER, ...rows].map((row) => row.map(escapeCell).join(",")).join("\n");
}

/** Client-only: build the CSV and trigger a browser download. */
export function downloadMenuCsv(view: MenuEngineeringView): void {
  if (typeof document === "undefined") return;

  const csv = buildMenuCsv(view);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `rop-menu-engineering-${view.windowDays}d.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
