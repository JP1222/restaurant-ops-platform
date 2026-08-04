import type { TrendsView } from "@/lib/analytics-api/trends-transform";

// One row per loaded bucket. Net sales, orders, and avg ticket are present on every
// point regardless of the charted metric, so the export is complete and metric-
// independent (refund-rate-only rows would otherwise be sparse). Dollars at 2dp.
const HEADER = ["Date", "Net Sales ($)", "Orders", "Avg Ticket ($)"];

function escapeCell(value: string | number): string {
  const str = String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

/** Pure: serialize the loaded trends series to CSV text (one row per bucket). */
export function buildTrendsCsv(view: TrendsView): string {
  const rows = view.points.map((point) => {
    const avgTicketCents = point.order_count > 0 ? point.net_sales_cents / point.order_count : 0;
    return [
      point.bucket_start,
      (point.net_sales_cents / 100).toFixed(2),
      point.order_count,
      (avgTicketCents / 100).toFixed(2)
    ];
  });
  return [HEADER, ...rows].map((row) => row.map(escapeCell).join(",")).join("\n");
}

/** Client-only: build the CSV and trigger a browser download. */
export function downloadTrendsCsv(view: TrendsView): void {
  if (typeof document === "undefined") return;

  const csv = buildTrendsCsv(view);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `rop-trends-${view.metric}-${view.from}_to_${view.to}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
