import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

// ADR-882 Phase 4b — the backoffice receipt review must collapse same-product-different-size
// lines into ONE item with many packs (mirrors crew scan-flow), instead of creating duplicate
// items in the wrong category (the Haribo-gummy "Dairy & Cream" screenshot bug). The grouping
// DECISION lives in `resolveScanPacks` (contracts, separately unit-tested); this suite guards the
// backoffice WIRING — buildRows -> RowState -> ReceiptApplyLine — through a real render.
//
// The card's two AI-assist tiers (semantic match + emoji) fire on mount via TanStack Query
// mutations. Stub them to no-ops so the test exercises the DETERMINISTIC grouping path only — no
// network, no QueryClientProvider needed. We render with react-dom/createRoot + act (happy-dom),
// the same dependency-free pattern as tests/lib/use-admin-users-error-map.test.ts (no RTL dep).
vi.mock("@/hooks/use-inventory", () => ({
  useMatchSuggest: () => ({ mutateAsync: async () => ({ suggestions: [], threshold: 1 }) }),
  useEmojiSuggest: () => ({ mutateAsync: async () => ({ suggestions: [] }) }),
}));

import { ReceiptBatchCard, type ReceiptApplyLine } from "@/components/ai/receipt-batch-card";
import type { InventoryReceiptParseResult } from "@rop/contracts";

// Two SIZES of one NEW product (not in the catalog): 28 oz + 5 lb. ADR-882: they collapse into one
// item in base unit oz (the most granular) with two packs (28 oz; 5 lb -> 80 oz), categorised
// "topping" (gummy), never two "Dairy & Cream" items.
const LINES: InventoryReceiptParseResult["lines"] = [
  { description: "GUMMY BEARS 28 OZ", canonical_name: "Gummy Bears 28 oz", qty: 2, unit: "bag", unit_price_cents: 663 },
  { description: "GUMMY BEARS 5 LB", canonical_name: "Gummy Bears 5 lb", qty: 1, unit: "bag", unit_price_cents: 1086 },
];

function renderCard(onApply: (lines: ReceiptApplyLine[]) => void) {
  return createElement(ReceiptBatchCard, {
    lines: LINES,
    source: { vendor: "Sam's Club" },
    items: [],
    aliases: [],
    applied: false,
    onApply,
    onCancel: () => {},
  });
}

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("ReceiptBatchCard grouping (ADR-882)", () => {
  test("collapses same-product different-size lines into one item with packs", async () => {
    const applied: ReceiptApplyLine[][] = [];
    await act(async () => {
      root.render(renderCard((lines) => applied.push(lines)));
    });
    await flush();

    // The grouping badge proves the two sizes collapsed into one item.
    expect(container.textContent).toContain("Same item");

    const confirm = container.querySelector<HTMLButtonElement>('[data-testid="receipt-batch-confirm"]');
    expect(confirm).not.toBeNull();
    await act(async () => {
      confirm!.click();
    });

    expect(applied).toHaveLength(1);
    const lines = applied[0]!;
    expect(lines).toHaveLength(2);
    // One family group, one base unit (oz), each printed size converted into it (5 lb -> 80 oz).
    expect(lines[0]!.itemGroup).toBe("fam:gummybear");
    expect(lines[1]!.itemGroup).toBe(lines[0]!.itemGroup);
    expect(lines[0]).toMatchObject({
      name: "Gummy Bears",
      category: "topping",
      unit: "oz",
      qty: 2,
      isNew: true,
      newPack: { label: "28 oz", base_qty_per_pack: 28 },
    });
    expect(lines[1]).toMatchObject({
      name: "Gummy Bears",
      category: "topping",
      unit: "oz",
      qty: 1,
      isNew: true,
      newPack: { label: "5 lb", base_qty_per_pack: 80 },
    });
  });

  test("Split reverts a grouped row to a standalone new item (no pack / group)", async () => {
    const applied: ReceiptApplyLine[][] = [];
    await act(async () => {
      root.render(renderCard((lines) => applied.push(lines)));
    });
    await flush();

    // Two grouped rows -> two "Split" controls; ungroup the first.
    const splitButtons = Array.from(container.querySelectorAll("button")).filter(
      (b) => b.textContent?.trim() === "Split",
    );
    expect(splitButtons).toHaveLength(2);
    await act(async () => {
      splitButtons[0]!.click();
    });
    await flush();

    const confirm = container.querySelector<HTMLButtonElement>('[data-testid="receipt-batch-confirm"]');
    await act(async () => {
      confirm!.click();
    });

    const lines = applied[0]!;
    // The split row becomes a plain new item: full name (size kept), printed unit, no pack/group.
    expect(lines[0]!.itemGroup).toBeUndefined();
    expect(lines[0]!.newPack).toBeUndefined();
    expect(lines[0]!.name).toBe("Gummy Bears 28 oz");
    expect(lines[0]!.unit).toBe("bag");
    // The untouched row stays grouped.
    expect(lines[1]!.itemGroup).toBe("fam:gummybear");
  });
});
