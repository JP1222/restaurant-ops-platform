"use client";

import { AlertTriangle, CheckCircle, Slash } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import { statusOf } from "@/lib/inventory/helpers";
import type { InventoryDataset } from "@rop/contracts";

import { ToneBadge } from "./status-badge";

export interface EightySixTabProps {
  data: InventoryDataset;
  onToggle86: (id: string) => void;
}

export function EightySixTab({ data, onToggle86 }: EightySixTabProps) {
  const e86 = data.items.filter((it) => it.flagged_86);
  const candidates = data.items
    .filter((it) => !it.flagged_86 && statusOf(it) === "critical")
    .slice(0, 8);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Currently 86&apos;d</CardDescription>
            <CardTitle className="mt-1 text-2xl font-medium tabular-nums">
              {e86.length}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Hidden from the KDS &amp; customer display.
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Critical candidates</CardDescription>
            <CardTitle className="mt-1 text-2xl font-medium tabular-nums">
              {candidates.length}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Below 50% par — pre-emptive 86 suggested.
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Auto-86 threshold</CardDescription>
            <CardTitle className="mt-1 text-2xl font-medium tabular-nums">0.5×</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Items auto-86 when on-hand &lt; par_min × 0.5
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>86&apos;d items — pushed live to KDS</CardTitle>
              <CardDescription>
                Removing from the list re-enables ordering immediately.
              </CardDescription>
            </div>
            <ToneBadge tone="eightysix" className="text-[11px]">
              live
            </ToneBadge>
          </div>
        </CardHeader>
        <CardContent>
          {e86.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">
              Nothing is currently 86&apos;d. Nice.
            </p>
          ) : (
            <div className="space-y-2">
              {e86.map((it) => (
                <div
                  key={it.id}
                  className="flex items-center gap-3 rounded-lg border border-border p-3"
                >
                  <div className="flex size-9 flex-none items-center justify-center rounded-md bg-zinc-900 text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900">
                    <Slash className="size-4" />
                  </div>
                  <div className="flex-1">
                    <div className="text-sm font-medium">{it.name}</div>
                    <div className="text-xs text-muted-foreground">
                      On hand{" "}
                      <span className="font-mono tabular-nums">{it.on_hand}</span> {it.unit} ·
                      Par{" "}
                      <span className="font-mono tabular-nums">
                        {it.par_min}/{it.par_max}
                      </span>{" "}
                      · 86&apos;d 08:28 by system
                    </div>
                  </div>
                  <Button variant="outline" onClick={() => onToggle86(it.id)}>
                    <CheckCircle className="size-3.5" />
                    Un-86
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Suggested 86 — critical stock</CardTitle>
          <CardDescription>
            These ingredients are below 50% par but still on the menu. One-click 86 to take
            dependent menu items offline.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {candidates.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">No critical-level items right now.</p>
          ) : (
            <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
              {candidates.map((it) => (
                <div
                  key={it.id}
                  className="flex items-center gap-3 rounded-lg border border-border p-3"
                >
                  <div className="flex size-9 flex-none items-center justify-center rounded-md bg-trend-down-bg text-trend-down">
                    <AlertTriangle className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{it.name}</div>
                    <div className="text-xs text-muted-foreground">
                      On hand <span className="font-mono tabular-nums">{it.on_hand}</span> / par{" "}
                      <span className="font-mono tabular-nums">{it.par_min}</span> {it.unit}
                    </div>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => onToggle86(it.id)}>
                    <Slash className="size-3.5" />
                    86 now
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
