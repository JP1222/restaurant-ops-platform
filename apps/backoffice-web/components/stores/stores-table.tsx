"use client";

import Link from "next/link";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useLocations } from "@/hooks/use-locations";
import type { ConnectionStatus } from "./connection-status-badge";
import { ConnectionStatusBadge } from "./connection-status-badge";

function deriveStatus(merchantId: string | null): ConnectionStatus {
  return merchantId !== null ? "connected" : "none";
}

function PlatformTile({ merchantId }: { merchantId: string | null }) {
  if (!merchantId) {
    return (
      <span className="inline-flex size-6 items-center justify-center rounded-md bg-muted font-mono text-xs font-semibold text-muted-foreground">
        ?
      </span>
    );
  }
  const isSquare = merchantId.startsWith("square:");
  return (
    <span
      className={
        isSquare
          ? "inline-flex size-6 items-center justify-center rounded-md bg-info-soft font-mono text-xs font-semibold text-info-foreground"
          : "inline-flex size-6 items-center justify-center rounded-md bg-accent-soft font-mono text-xs font-semibold text-trend-up"
      }
    >
      {isSquare ? "S" : "C"}
    </span>
  );
}

export function StoresTable() {
  const { data, isLoading, isError } = useLocations();

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  if (isError) {
    return <p className="text-sm text-destructive">Could not load stores.</p>;
  }

  const locations = data?.locations ?? [];

  if (locations.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed py-16 text-center">
        <p className="text-sm font-medium">No stores yet</p>
        <p className="mt-1 max-w-xs text-[13px] text-muted-foreground">
          Add your first store to connect a POS and start seeing data.
        </p>
        <Button asChild className="mt-4" size="sm">
          <Link href="/settings/stores/new">
            <Plus className="mr-1.5 size-4" />
            Add store
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      {/* Desktop table */}
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-[2fr] text-[11.5px] font-semibold uppercase tracking-[0.04em]">
                Name
              </TableHead>
              <TableHead className="w-[1.3fr] text-[11.5px] font-semibold uppercase tracking-[0.04em]">
                Platform
              </TableHead>
              <TableHead className="w-[1.4fr] text-[11.5px] font-semibold uppercase tracking-[0.04em]">
                Location
              </TableHead>
              <TableHead className="w-[1.3fr] text-[11.5px] font-semibold uppercase tracking-[0.04em]">
                Status
              </TableHead>
              <TableHead className="w-[90px] text-right text-[11.5px] font-semibold uppercase tracking-[0.04em]">
                Actions
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {locations.map((loc) => (
              <TableRow key={loc.id} className="text-[13.5px]">
                <TableCell className="font-semibold">{loc.name}</TableCell>
                <TableCell>
                  <span className="flex items-center gap-2">
                    <PlatformTile merchantId={loc.merchantId} />
                    <span className="text-muted-foreground">
                      {loc.merchantId?.startsWith("square:") ? "Square" : loc.merchantId ? "Clover" : "—"}
                    </span>
                  </span>
                </TableCell>
                <TableCell className="text-muted-foreground">{loc.timezone || "—"}</TableCell>
                <TableCell>
                  <ConnectionStatusBadge status={deriveStatus(loc.merchantId)} />
                </TableCell>
                <TableCell className="text-right">
                  <Button asChild variant="outline" size="sm" className="h-[30px] rounded-[7px] text-xs">
                    <Link href={`/settings/stores/${loc.id}`}>Manage</Link>
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Mobile card list */}
      <div className="md:hidden">
        {locations.map((loc, i) => (
          <Link
            key={loc.id}
            href={`/settings/stores/${loc.id}`}
            className={`flex items-center gap-3 px-4 py-3 hover:bg-muted/50 ${i < locations.length - 1 ? "border-b" : ""}`}
          >
            <span
              className={
                loc.merchantId?.startsWith("square:")
                  ? "flex size-[34px] shrink-0 items-center justify-center rounded-lg bg-info-soft font-mono text-sm font-semibold text-info-foreground"
                  : "flex size-[34px] shrink-0 items-center justify-center rounded-lg bg-accent-soft font-mono text-sm font-semibold text-trend-up"
              }
            >
              {loc.merchantId?.startsWith("square:") ? "S" : "C"}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13.5px] font-semibold">{loc.name}</p>
              <p className="truncate text-[11.5px] text-muted-foreground">
                {loc.merchantId?.startsWith("square:") ? "Square" : loc.merchantId ? "Clover" : "No POS"} ·{" "}
                {loc.timezone || "—"}
              </p>
            </div>
            <ConnectionStatusBadge status={deriveStatus(loc.merchantId)} compact />
          </Link>
        ))}
      </div>
    </div>
  );
}
