"use client";

import { ArrowUpDown } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { cn } from "@/lib/utils";
import { formatCents, formatCount, formatRate } from "@/lib/format";
import { QUADRANT_COLOR, QUADRANT_LABEL } from "@/lib/menu/quadrant-colors";
import type { MenuEngineeringItem, MenuEngineeringView } from "@/lib/menu/kasavana-smith";

function HeaderButton({
  label,
  onClick
}: {
  label: string;
  onClick: (() => void) | undefined;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onClick}
      className="ml-auto h-7 px-2 text-xs font-medium text-muted-foreground"
    >
      {label}
      <ArrowUpDown className="ml-1 size-3" />
    </Button>
  );
}

function numericColumn(
  key: keyof MenuEngineeringItem,
  label: string,
  render: (item: MenuEngineeringItem) => React.ReactNode,
  cellClassName?: string
): ColumnDef<MenuEngineeringItem, unknown> {
  return {
    accessorKey: key,
    header: ({ column }) => (
      <HeaderButton
        label={label}
        onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
      />
    ),
    cell: ({ row }) => (
      <div className={cn("text-right font-mono tabular-nums", cellClassName)}>
        {render(row.original)}
      </div>
    )
  };
}

function buildColumns(): ColumnDef<MenuEngineeringItem, unknown>[] {
  return [
    {
      accessorKey: "rank",
      header: () => <span className="text-xs font-medium text-muted-foreground">#</span>,
      cell: ({ row }) => (
        <span className="tabular-nums text-muted-foreground">{row.original.rank}</span>
      ),
      enableSorting: false
    },
    {
      accessorKey: "item_name",
      header: () => <span className="text-xs font-medium text-muted-foreground">Item</span>,
      cell: ({ row }) => (
        <span className="font-medium text-foreground">{row.original.item_name}</span>
      ),
      enableSorting: false
    },
    {
      accessorKey: "quadrant",
      header: () => (
        <span className="text-xs font-medium text-muted-foreground">Quadrant</span>
      ),
      cell: ({ row }) => {
        const quadrant = row.original.quadrant;
        return (
          <Badge variant="outline" className="gap-1.5">
            <span
              aria-hidden
              className="inline-block size-2 rounded-full"
              style={{ background: QUADRANT_COLOR[quadrant] }}
            />
            {QUADRANT_LABEL[quadrant]}
          </Badge>
        );
      },
      enableSorting: false
    },
    numericColumn("units", "Units", (item) => formatCount(item.units)),
    numericColumn("revenue_cents", "Revenue", (item) => formatCents(item.revenue_cents)),
    numericColumn(
      "plate_cost_cents",
      "Plate cost",
      (item) => formatCents(item.plate_cost_cents),
      "text-muted-foreground"
    ),
    numericColumn(
      "margin_cents",
      "Contribution margin",
      (item) => formatCents(item.margin_cents),
      "font-medium text-[var(--trend-up)]"
    ),
    numericColumn("margin_pct", "Margin %", (item) => formatRate(item.margin_pct))
  ];
}

export interface ItemsTableProps {
  view: MenuEngineeringView;
  onSelect: (fingerprint: string) => void;
}

export function ItemsTable({ view, onSelect }: ItemsTableProps) {
  return (
    <DataTable
      columns={buildColumns()}
      data={view.items}
      onRowClick={(row) => onSelect(row.original.item_fingerprint)}
      emptyMessage="No costed items in the selected window."
    />
  );
}
