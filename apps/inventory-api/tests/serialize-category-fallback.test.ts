import { defaultInventoryCategories } from "@rop/contracts";
import { describe, expect, it } from "vitest";

import { assembleDataset, type DatasetRows } from "../src/lib/serialize.js";

// assembleDataset throws without the waste_settings/metrics singletons; their
// exact values are irrelevant to the category assertion, so use minimal valid rows.
const baseRows: DatasetRows = {
  categories: [],
  items: [],
  itemStates: [],
  recipes: [],
  vendors: [],
  vendorQuotes: [],
  itemAliases: [],
  pos: [],
  counts: [],
  wasteReasons: [],
  wasteLog: [],
  activity: [],
  wasteSettings: {
    id: "singleton",
    photoRequiredOverCents: 2500,
    managerApprovalOverCents: 5000
  },
  metrics: {
    id: "singleton",
    cogsTargetPct: 0.3
  }
};

describe("assembleDataset category cold-start fallback", () => {
  it("returns the 7 canonical categories when the table is un-seeded (empty)", () => {
    // The bug: a fresh prod DB has no inventory_categories rows, so the dataset's
    // category list was empty and the "Add item" picker rendered blank, blocking
    // creation of the first item. The dataset must surface the domain constants.
    const ds = assembleDataset(baseRows);
    expect(ds.categories).toEqual(defaultInventoryCategories);
    expect(ds.categories).toHaveLength(8);
  });

  it("uses the DB rows verbatim when the table has rows (override wins)", () => {
    const ds = assembleDataset({
      ...baseRows,
      categories: [
        {
          id: "food",
          name: "Custom Proteins",
          color: "tomato",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z")
        }
      ]
    });
    expect(ds.categories).toEqual([{ id: "food", name: "Custom Proteins", color: "tomato" }]);
  });
});
