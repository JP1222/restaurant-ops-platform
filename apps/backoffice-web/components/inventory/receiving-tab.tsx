"use client";

import * as React from "react";
import { Plus, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import { formatCents } from "@/lib/format";
import type { InventoryDataset, InventoryPurchaseOrder } from "@rop/contracts";

import { NewPoBuilder } from "./new-po-builder";
import { ReceiptHistory } from "./receipt-history";
import { ReceiveIntakeSheet } from "./receive-intake-sheet";
import { ToneBadge } from "./status-badge";

const STATUS_META: Record<
  InventoryPurchaseOrder["status"],
  { tone: "info" | "warn" | "accent"; label: string }
> = {
  submitted: { tone: "info", label: "Submitted" },
  "in-transit": { tone: "warn", label: "In transit" },
  received: { tone: "accent", label: "Received" },
  // Cancelled POs are excluded from the dataset the API serves, so this never
  // renders today — kept for type completeness over the status enum.
  cancelled: { tone: "warn", label: "Cancelled" }
};

// submitted / in-transit POs can still be changed; received is immutable.
function isEditable(status: InventoryPurchaseOrder["status"]): boolean {
  return status === "submitted" || status === "in-transit";
}

function PoRow({ po, onEdit }: { po: InventoryPurchaseOrder; onEdit: (id: string) => void }) {
  const meta = STATUS_META[po.status];
  return (
    <tr className="border-b border-border last:border-0 hover:bg-secondary/40">
      <td className="py-3 pr-4 font-mono text-xs tabular-nums">{po.id}</td>
      <td className="py-3 pr-4">
        <div className="text-sm font-medium">{po.vendor}</div>
      </td>
      <td className="py-3 pr-4 font-mono text-xs tabular-nums text-muted-foreground">
        {po.placed}
      </td>
      <td className="py-3 pr-4 font-mono text-xs tabular-nums">{po.expected}</td>
      <td className="py-3 pr-4 text-right font-mono tabular-nums">{po.lines}</td>
      <td className="py-3 pr-4 text-right font-mono tabular-nums">
        {formatCents(po.total_cents)}
      </td>
      <td className="py-3 pl-4">
        <ToneBadge tone={meta.tone} dot>
          {meta.label}
        </ToneBadge>
      </td>
      <td className="py-3 pl-4 text-right">
        {isEditable(po.status) ? (
          <Button size="sm" variant="outline" onClick={() => onEdit(po.id)}>
            Edit
          </Button>
        ) : null}
      </td>
    </tr>
  );
}

function PoCard({ po, onEdit }: { po: InventoryPurchaseOrder; onEdit: (id: string) => void }) {
  const meta = STATUS_META[po.status];
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{po.vendor}</div>
          <div className="mt-0.5 font-mono text-[11px] tabular-nums text-muted-foreground">
            {po.id} · placed {po.placed}
          </div>
        </div>
        <ToneBadge tone={meta.tone} dot>
          {meta.label}
        </ToneBadge>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
        <div>
          <div className="text-muted-foreground">Expected</div>
          <div className="mt-0.5 font-mono font-medium tabular-nums">{po.expected}</div>
        </div>
        <div>
          <div className="text-muted-foreground">Lines</div>
          <div className="mt-0.5 font-mono font-medium tabular-nums">{po.lines}</div>
        </div>
        <div>
          <div className="text-muted-foreground">Total</div>
          <div className="mt-0.5 font-mono font-medium tabular-nums">
            {formatCents(po.total_cents)}
          </div>
        </div>
      </div>
      {isEditable(po.status) ? (
        <div className="mt-3 flex justify-end">
          <Button size="sm" variant="outline" onClick={() => onEdit(po.id)}>
            Edit
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export interface ReceivingTabProps {
  data: InventoryDataset;
  mobile: boolean;
}

export function ReceivingTab({ data, mobile }: ReceivingTabProps) {
  const [poOpen, setPoOpen] = React.useState(false);
  const [receiveOpen, setReceiveOpen] = React.useState(false);
  // Non-null while the edit drawer is open for a specific PO.
  const [editPoId, setEditPoId] = React.useState<string | null>(null);
  const openValue = data.pos
    .filter((p) => p.status !== "received")
    .reduce((s, p) => s + p.total_cents, 0);
  const inTransit = data.pos.filter((p) => p.status === "in-transit").length;
  const submitted = data.pos.filter((p) => p.status === "submitted").length;
  const openCount = data.pos.filter((p) => p.status !== "received").length;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Open PO value</CardDescription>
            <CardTitle className="mt-1 text-2xl font-medium tabular-nums">
              {formatCents(openValue)}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {openCount} open · {data.pos.length} total this week
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Arriving today</CardDescription>
            <CardTitle className="mt-1 text-2xl font-medium tabular-nums">
              {inTransit}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Sysco, True World, WebstaurantStore on the dock.
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Awaiting confirmation</CardDescription>
            <CardTitle className="mt-1 text-2xl font-medium tabular-nums">
              {submitted}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Submitted but not yet acknowledged by vendor.
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <CardTitle>Purchase orders — this week</CardTitle>
              <CardDescription>
                Auto-generated from par shortfalls and standing orders.
              </CardDescription>
            </div>
            <div className="flex flex-none items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => setReceiveOpen(true)}>
                <Upload className="size-3.5" />
                Receive
              </Button>
              <Button size="sm" onClick={() => setPoOpen(true)}>
                <Plus className="size-3.5" />
                {mobile ? "New" : "New PO"}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className={mobile ? "px-4 pb-4" : undefined}>
          {mobile ? (
            <div className="space-y-2">
              {data.pos.map((po) => (
                <PoCard key={po.id} po={po} onEdit={setEditPoId} />
              ))}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">PO</th>
                  <th className="py-2 pr-4 font-medium">Vendor</th>
                  <th className="py-2 pr-4 font-medium">Placed</th>
                  <th className="py-2 pr-4 font-medium">Expected</th>
                  <th className="py-2 pr-4 text-right font-medium">Lines</th>
                  <th className="py-2 pr-4 text-right font-medium">Total</th>
                  <th className="py-2 pl-4 font-medium">Status</th>
                  <th className="py-2 pl-4 font-medium" />
                </tr>
              </thead>
              <tbody>
                {data.pos.map((po) => (
                  <PoRow key={po.id} po={po} onEdit={setEditPoId} />
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <ReceiptHistory mobile={mobile} />

      {poOpen ? (
        <NewPoBuilder
          open
          onOpenChange={(next) => {
            if (!next) setPoOpen(false);
          }}
          data={data}
        />
      ) : null}

      {editPoId ? (
        <NewPoBuilder
          key={editPoId}
          open
          onOpenChange={(next) => {
            if (!next) setEditPoId(null);
          }}
          data={data}
          editId={editPoId}
        />
      ) : null}

      {receiveOpen ? (
        <ReceiveIntakeSheet
          open
          onOpenChange={(next) => {
            if (!next) setReceiveOpen(false);
          }}
          data={data}
        />
      ) : null}
    </div>
  );
}
