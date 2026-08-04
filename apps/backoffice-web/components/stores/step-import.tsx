"use client";

import { useState } from "react";
import {
  ChevronDown,
  CircleAlert,
  Download,
  History,
  LoaderCircle,
  PackageOpen,
  RotateCcw,
  UtensilsCrossed,
} from "lucide-react";
import type { CatalogImportResult } from "@rop/contracts";
import { Button } from "@/components/ui/button";
import { useImportSquareCatalog } from "@/hooks/use-square";
import { cn } from "@/lib/utils";

export type { CatalogImportResult };
export type ImportState = "idle" | "running" | "success" | "empty" | "error";

export interface ImportStepState {
  importState: ImportState;
  importResult: CatalogImportResult | null;
}

interface StepImportProps {
  state: ImportStepState;
  platform: "clover" | "square";
  // The connected store's PosStore id (`square:{location_id}`) — required to
  // import the live catalog. Absent until the Square connect step completes.
  posStoreId?: string | null;
  onChange: (partial: Partial<ImportStepState>) => void;
}

export function StepImport({ state, platform, posStoreId, onChange }: StepImportProps) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const importCatalog = useImportSquareCatalog();

  const handleImport = async () => {
    if (!posStoreId) return;
    onChange({ importState: "running", importResult: null });
    try {
      const result = await importCatalog.mutateAsync({ posStoreId });
      // A connected store with an empty catalog is a distinct, non-error state.
      onChange({
        importState: result.itemCount === 0 ? "empty" : "success",
        importResult: result,
      });
    } catch {
      onChange({ importState: "error", importResult: null });
    }
  };

  const handleRetry = () => {
    onChange({ importState: "idle", importResult: null });
  };

  const durationSecs = state.importResult
    ? (state.importResult.durationMs / 1000).toFixed(1)
    : "0";

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-[19px] font-semibold">Import your data</h2>
        <p className="mt-1 text-[13.5px] text-muted-foreground">
          Bring your menu in now so the rest of Example Kitchen works right away.
        </p>
      </div>

      <div className="max-w-[540px] space-y-3.5">
        {/* Menu catalog card */}
        <div className="rounded-[14px] border bg-card p-5">
          <div className="flex items-start gap-3">
            <span className="flex size-[38px] shrink-0 items-center justify-center rounded-lg bg-accent-soft">
              <UtensilsCrossed className="size-5 text-accent" />
            </span>
            <div className="flex-1">
              <p className="text-[14px] font-semibold">Menu</p>
              <p className="text-[13px] text-muted-foreground">
                Items, modifiers and categories from {platform === "square" ? "Square" : "Clover"}.
              </p>
            </div>
          </div>

          <div className="mt-4">
            {state.importState === "idle" && (
              <Button
                onClick={handleImport}
                size="sm"
                className="h-9 rounded-[9px]"
                disabled={platform !== "square" || !posStoreId}
              >
                <Download className="mr-2 size-4" />
                Import menu
              </Button>
            )}

            {state.importState === "running" && (
              <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
                <LoaderCircle className="size-4 animate-spin" />
                Reading catalog from {platform === "square" ? "Square" : "Clover"}…
              </div>
            )}

            {state.importState === "success" && state.importResult && (
              <div className="rounded-lg border border-accent bg-accent-soft p-3">
                <p className="text-[13.5px] font-semibold text-trend-up">
                  Imported {state.importResult.itemCount} items ·{" "}
                  {state.importResult.modifierCount} modifiers ·{" "}
                  {state.importResult.categoryCount} categories
                </p>
                <p className="mt-0.5 text-[12px] text-muted-foreground">
                  Done in {durationSecs}s ·{" "}
                  <button
                    type="button"
                    onClick={handleRetry}
                    className="underline hover:text-foreground"
                  >
                    re-import
                  </button>
                </p>
              </div>
            )}

            {state.importState === "empty" && (
              <div className="rounded-lg border border-dashed bg-muted/30 p-4 text-center">
                <PackageOpen className="mx-auto mb-1.5 size-5 text-muted-foreground" />
                <p className="text-[13px] text-muted-foreground">
                  No catalog found in this location. You can build your menu in Example Kitchen, or import later
                  from store settings.
                </p>
              </div>
            )}

            {state.importState === "error" && (
              <div className="rounded-lg border border-destructive bg-destructive-soft p-3">
                <div className="flex items-start gap-2">
                  <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
                  <div>
                    <p className="text-[13px] font-semibold text-foreground">Import failed partway</p>
                    <p className="mt-0.5 text-[12px] text-muted-foreground">
                      Nothing was saved, so it&apos;s safe to retry.
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleRetry}
                      className="mt-2 h-7 text-xs"
                    >
                      <RotateCcw className="mr-1.5 size-3" />
                      Retry import
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Historical import — collapsible */}
        <div className="rounded-[14px] border bg-card">
          <button
            type="button"
            onClick={() => setHistoryOpen((o) => !o)}
            className="flex w-full items-center gap-3 p-5 text-left"
          >
            <span className="flex size-[38px] shrink-0 items-center justify-center rounded-lg bg-muted">
              <History className="size-5 text-muted-foreground" />
            </span>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <p className="text-[14px] font-semibold">Import sales history</p>
                <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                  Optional
                </span>
              </div>
              <p className="text-[13px] text-muted-foreground">
                Backfills analytics so trends and forecasts work from day one.
              </p>
            </div>
            <ChevronDown
              className={cn(
                "size-4 shrink-0 text-muted-foreground transition-transform",
                historyOpen && "rotate-180",
              )}
            />
          </button>

          {historyOpen && (
            <div className="border-t px-5 pb-5 pt-4">
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1.5">
                  <label className="text-[12px] text-muted-foreground">From</label>
                  <input
                    type="date"
                    className="h-9 rounded-[9px] border bg-background px-3 text-[13px] focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[12px] text-muted-foreground">To</label>
                  <input
                    type="date"
                    className="h-9 rounded-[9px] border bg-background px-3 text-[13px] focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
                <Button variant="outline" size="sm" className="h-9 rounded-[9px]">
                  Import history
                </Button>
              </div>
              <p className="mt-2 text-[12px] text-muted-foreground">
                Historical import is Phase 2 — coming soon.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
