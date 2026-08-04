"use client";

import { createContext, useContext, type ReactNode } from "react";

import type {
  InventoryCategory,
  InventoryItem,
  InventoryItemAlias,
  InventoryPurchaseOrder,
  InventoryWasteReason,
  InventoryWasteSettings
} from "@rop/contracts";

// The fetched inventory dataset, shared with the flow screens. Plain React
// context (not react-query) so deeply nested pickers read it without prop
// threading while crew-web stays lean.
export interface CrewData {
  items: InventoryItem[];
  categories: InventoryCategory[];
  pos: InventoryPurchaseOrder[];
  wasteReasons: InventoryWasteReason[];
  wasteSettings: InventoryWasteSettings;
  // Learned vendor->item aliases (ADR-0586) for the scan matcher's memory tier.
  aliases: InventoryItemAlias[];
}

const CrewDataContext = createContext<CrewData | null>(null);

export function CrewDataProvider({ value, children }: { value: CrewData; children: ReactNode }) {
  return <CrewDataContext.Provider value={value}>{children}</CrewDataContext.Provider>;
}

export function useCrewData(): CrewData {
  const ctx = useContext(CrewDataContext);
  if (!ctx) {
    throw new Error("useCrewData must be used within CrewDataProvider");
  }
  return ctx;
}
