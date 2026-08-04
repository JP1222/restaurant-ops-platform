"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useInventory } from "@/hooks/use-inventory";
import { useIsMobile } from "@/lib/inventory/use-is-mobile";
import { cn } from "@/lib/utils";

import { ContextFab, type FabAction } from "./context-fab";
import { CountModeModal } from "./count-mode-modal";
import { CountsTab } from "./counts-tab";
import { EightySixTab } from "./eighty-six-tab";
import { ItemDetailSheet } from "./item-detail-sheet";
import { ItemsTab } from "./items-tab";
import { MobileBottomNav } from "./mobile-bottom-nav";
import { OverviewTab } from "./overview-tab";
import { ReceivingTab } from "./receiving-tab";
import { RecipesTab } from "./recipes-tab";
import { RecordWasteSheet } from "./record-waste-sheet";
import { TabStrip, type Tab } from "./tab-strip";
import { VendorsTab } from "./vendors-tab";
import { WasteTab } from "./waste-tab";

const TAB_META: Record<string, { label: string; title: string; desc: string }> = {
  overview: {
    label: "Overview",
    title: "Inventory",
    desc: "Live stock, COGS, recipe costing, and ingredient health for the Anytown store."
  },
  items: {
    label: "Items",
    title: "Items",
    desc: "Every SKU in active use. Search, filter by status, and open any item to edit par or push to 86 on the KDS."
  },
  recipes: {
    label: "Recipes",
    title: "Recipes & costing",
    desc: "Menu items rolled up against current ingredient cost. Flag dishes drifting above the target food-cost %."
  },
  counts: {
    label: "Counts",
    title: "Counts",
    desc: "Physical counts vs. theoretical on-hand. Variance shown in both percent and dollar impact on COGS."
  },
  receiving: {
    label: "Receiving",
    title: "Receiving",
    desc: "Open purchase orders and short-dated receives. Reconcile shipments against the placed PO line-by-line."
  },
  vendors: {
    label: "Vendors",
    title: "Vendors",
    desc: "Supplier directory with fill-rate, on-time, and price-stability scoring. Side-by-side SKU price comparison across vendors."
  },
  waste: {
    label: "Waste",
    title: "Waste",
    desc: "Log spoilage, prep errors, comps, and overproduction. Photo + manager approval thresholds keep the data honest."
  },
  "86": {
    label: "86 list",
    title: "86 list",
    desc: "Items hidden from the KDS and customer display. Anything below 0.5x par auto-86's; you can also pre-empt."
  }
};

// Explicit order: Object.entries floats the integer-like "86" key ahead of the
// string keys (JS iterates integer-index keys first), which pushed Overview out
// of first place. Drive order from this list instead of object insertion order.
const TAB_ORDER = ["overview", "items", "recipes", "counts", "receiving", "vendors", "waste", "86"];
const TABS: Tab[] = TAB_ORDER.map((id) => ({ id, label: TAB_META[id]?.label ?? id }));

export function InventoryPageClient() {
  const mobile = useIsMobile();
  const {
    data,
    isError,
    toggle86,
    applyCountAdjustments,
    recordWaste,
    saveItem,
    updatePar,
    archiveItem,
    syncSales,
    isSyncing
  } = useInventory();

  // Honor a ?tab= deep link (e.g. the "Add recipes" nudge on /costs and /menu) as the
  // initial tab. Read via useSearchParams (same pattern as the /compare page) so it is
  // hydration-safe and avoids a set-state-in-effect.
  const requestedTab = useSearchParams().get("tab");
  const [active, setActive] = React.useState<string>(
    requestedTab && TAB_ORDER.includes(requestedTab) ? requestedTab : "overview"
  );
  const [openItemId, setOpenItemId] = React.useState<string | null>(null);
  const [countModeOpen, setCountModeOpen] = React.useState(false);
  const [recordWasteOpen, setRecordWasteOpen] = React.useState(false);

  if (!data) {
    return (
      <div className="mx-auto w-full max-w-[1400px]">
        <div className="py-24 text-center text-sm text-muted-foreground">
          {isError
            ? "Couldn’t load inventory. Confirm inventory-api is reachable, then retry."
            : "Loading inventory…"}
        </div>
      </div>
    );
  }

  const meta = TAB_META[active] ?? TAB_META.overview!;

  const onFabAction = (action: FabAction) => {
    if (action === "count") setCountModeOpen(true);
    if (action === "waste") setRecordWasteOpen(true);
  };

  const runSyncSales = async () => {
    try {
      const result = await syncSales();
      if (result.applied === 0 && result.unmatched.length === 0) {
        toast.success("No new sales to sync");
      } else {
        const note =
          result.unmatched.length > 0
            ? ` · ${result.unmatched.length} item${result.unmatched.length === 1 ? "" : "s"} not set up`
            : "";
        toast.success(
          `Synced — depleted ${result.applied} sale line${result.applied === 1 ? "" : "s"}${note}`
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      toast.error(
        /sales_feed_not_configured|not configured|503/.test(message)
          ? "Sales feed isn’t connected yet"
          : "Sync failed — try again"
      );
    }
  };

  return (
    <div className="relative">
      <div
        className={cn(
          "mx-auto w-full max-w-[1400px] space-y-5 sm:space-y-6",
          mobile && "pb-32"
        )}
      >
        <header className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h1
              className={cn(
                "font-medium tracking-tight",
                mobile ? "text-2xl" : "text-3xl"
              )}
            >
              {meta.title}
            </h1>
            <p
              className={cn(
                "max-w-3xl text-sm text-muted-foreground",
                mobile && "hidden"
              )}
            >
              {meta.desc}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="flex-none"
            disabled={isSyncing}
            onClick={runSyncSales}
          >
            <RefreshCw className={cn("size-3.5", isSyncing && "animate-spin")} />
            {isSyncing ? "Syncing…" : "Sync sales"}
          </Button>
        </header>

        <TabStrip active={active} tabs={TABS} onChange={setActive} />

        {active === "overview" && (
          <OverviewTab
            data={data}
            onPickItem={(id) => {
              setActive("items");
              setOpenItemId(id);
            }}
            onJump={setActive}
            onCount={applyCountAdjustments}
          />
        )}
        {active === "items" && (
          <ItemsTab
            data={data}
            mobile={mobile}
            onPick={setOpenItemId}
            onRestore={(id) => archiveItem(id, false)}
          />
        )}
        {active === "recipes" && <RecipesTab data={data} />}
        {active === "counts" && (
          <CountsTab
            data={data}
            mobile={mobile}
            onStartCount={() => setCountModeOpen(true)}
          />
        )}
        {active === "receiving" && <ReceivingTab data={data} mobile={mobile} />}
        {active === "vendors" && (
          <VendorsTab
            data={data}
            mobile={mobile}
            onPickSku={(id) => {
              setActive("items");
              setOpenItemId(id);
            }}
          />
        )}
        {active === "waste" && (
          <WasteTab data={data} onOpenRecord={() => setRecordWasteOpen(true)} />
        )}
        {active === "86" && <EightySixTab data={data} onToggle86={toggle86} />}
      </div>

      <ItemDetailSheet
        openId={openItemId}
        data={data}
        onClose={() => setOpenItemId(null)}
        onToggle86={toggle86}
        onSaveItem={saveItem}
        onUpdatePar={updatePar}
        onArchiveItem={(id) => {
          archiveItem(id, true);
          setOpenItemId(null);
        }}
        onCount={applyCountAdjustments}
        mobile={mobile}
      />

      <ContextFab active={active} mobile={mobile} onAction={onFabAction} />
      <MobileBottomNav active={active} onChange={setActive} />

      <CountModeModal
        open={countModeOpen}
        data={data}
        onAdjustItems={applyCountAdjustments}
        onClose={() => setCountModeOpen(false)}
      />

      <RecordWasteSheet
        open={recordWasteOpen}
        data={data}
        onClose={() => setRecordWasteOpen(false)}
        onSubmit={(entry) => {
          recordWaste(entry);
          setRecordWasteOpen(false);
        }}
        mobile={mobile}
      />
    </div>
  );
}
