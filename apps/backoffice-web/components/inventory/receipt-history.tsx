"use client";

import * as React from "react";
import { ImageOff, ReceiptText } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCents } from "@/lib/format";
import { useReceipts } from "@/hooks/use-inventory";
import type { InventoryReceiptScan } from "@rop/contracts";

// The BFF proxies the bytes from inventory-api (Iron Law 4 — the browser can't reach
// inventory-api directly), so an <img src> renders same-origin.
function receiptImageSrc(id: string): string {
  return `/api/inventory/receipts/${encodeURIComponent(id)}/image`;
}

// Group day key + labels from the capture timestamp, in the viewer's locale/timezone
// (single-store backoffice, so browser ~ store TZ — good enough for a "which day" view).
function dayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}
function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

// Receipts arrive newest-first; Map preserves first-seen day order, so groups stay
// newest-day-first without a re-sort.
function groupByDay(receipts: InventoryReceiptScan[]): { day: string; items: InventoryReceiptScan[] }[] {
  const groups = new Map<string, InventoryReceiptScan[]>();
  for (const r of receipts) {
    const key = dayLabel(r.captured_at);
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(r);
    } else {
      groups.set(key, [r]);
    }
  }
  return Array.from(groups, ([day, items]) => ({ day, items }));
}

function ReceiptRow({
  receipt,
  open,
  onToggle
}: {
  receipt: InventoryReceiptScan;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="rounded-lg border border-border bg-card">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-3 p-3 text-left hover:bg-secondary/40"
      >
        <div className="flex size-12 flex-none items-center justify-center overflow-hidden rounded-md border border-border bg-secondary">
          {receipt.has_image ? (
            // eslint-disable-next-line @next/next/no-img-element -- bytes proxied through our BFF; next/image's loader isn't wired for it
            <img src={receiptImageSrc(receipt.id)} alt="" className="size-full object-cover" />
          ) : (
            <ImageOff className="size-5 text-muted-foreground" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{receipt.vendor || "Unknown vendor"}</div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {timeLabel(receipt.captured_at)} · {receipt.who}
            {receipt.invoice_date ? ` · invoice ${receipt.invoice_date}` : ""}
          </div>
        </div>
        <div className="flex-none text-right">
          <div className="font-mono text-sm tabular-nums">{formatCents(receipt.total_cents)}</div>
          <div className="text-xs text-muted-foreground">
            {receipt.line_count} {receipt.line_count === 1 ? "line" : "lines"}
          </div>
        </div>
      </button>
      {open ? (
        <div className="border-t border-border p-3">
          <div className="grid gap-3 md:grid-cols-[220px_1fr]">
            {receipt.has_image ? (
              <a
                href={receiptImageSrc(receipt.id)}
                target="_blank"
                rel="noopener noreferrer"
                className="block"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- bytes proxied through our BFF */}
                <img
                  src={receiptImageSrc(receipt.id)}
                  alt={`Scanned receipt from ${receipt.vendor || "unknown vendor"}`}
                  className="w-full rounded-md border border-border"
                />
              </a>
            ) : (
              <div className="rounded-md border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
                Image wasn&apos;t stored for this scan.
              </div>
            )}
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-1.5 pr-3 font-medium">Item</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Qty</th>
                  <th className="py-1.5 text-right font-medium">Unit cost</th>
                </tr>
              </thead>
              <tbody>
                {receipt.lines.map((line, i) => (
                  <tr key={i} className="border-b border-border last:border-0">
                    <td className="py-1.5 pr-3">{line.description || "—"}</td>
                    <td className="py-1.5 pr-3 text-right font-mono tabular-nums">
                      {line.qty}
                      {line.unit ? ` ${line.unit}` : ""}
                    </td>
                    <td className="py-1.5 text-right font-mono tabular-nums">
                      {line.unit_cost_cents !== undefined
                        ? formatCents(Math.round(line.unit_cost_cents))
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// Receipt history (receipt-archive): the original scanned invoices from confirmed
// receives, grouped by day. Its own fetch (useReceipts) — receipts aren't in the hot
// dataset. Click a row to see the line snapshot + the full image.
export function ReceiptHistory({ mobile }: { mobile: boolean }) {
  const { data, isLoading, isError } = useReceipts();
  const [openId, setOpenId] = React.useState<string | null>(null);
  // Derive groups inside the memo (keyed on data?.receipts) so an undefined-data render
  // doesn't mint a fresh [] each time and thrash the memo. No receipts => no groups.
  const groups = React.useMemo(() => groupByDay(data?.receipts ?? []), [data?.receipts]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ReceiptText className="size-4" />
          Receipt history
        </CardTitle>
        <CardDescription>Original scanned invoices from confirmed receives, newest first.</CardDescription>
      </CardHeader>
      <CardContent className={mobile ? "px-4 pb-4" : undefined}>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : isError ? (
          <p className="text-sm text-destructive">Couldn&apos;t load receipt history.</p>
        ) : groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No scanned receipts yet. Deliveries scanned in the crew app show up here.
          </p>
        ) : (
          <div className="space-y-5">
            {groups.map((group) => (
              <div key={group.day}>
                <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {group.day}
                </div>
                <div className="space-y-2">
                  {group.items.map((receipt) => (
                    <ReceiptRow
                      key={receipt.id}
                      receipt={receipt}
                      open={openId === receipt.id}
                      onToggle={() => setOpenId((cur) => (cur === receipt.id ? null : receipt.id))}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
