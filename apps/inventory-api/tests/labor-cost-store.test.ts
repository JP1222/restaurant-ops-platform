import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@rop/db-inventory";

import { listLaborCostSnapshots, saveLaborCost } from "../src/lib/labor-cost-store.js";

describe("listLaborCostSnapshots", () => {
  it("returns [] and skips the DB when no merchant is configured", async () => {
    const findMany = vi.fn();
    const prisma = { inventoryLaborCost: { findMany } } as unknown as PrismaClient;
    expect(await listLaborCostSnapshots(prisma, undefined)).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("stamps each effective-dated row with the configured merchant id", async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        locationId: "default-location",
        effectiveFrom: "2026-06-01",
        dailyLaborCostCents: 46666.67,
        currency: "USD",
        note: "$2,800/wk / 6 days"
      }
    ]);
    const prisma = { inventoryLaborCost: { findMany } } as unknown as PrismaClient;

    const out = await listLaborCostSnapshots(prisma, "M1");
    expect(out).toEqual([
      {
        merchant_id: "M1",
        daily_labor_cost_cents: 46666.67,
        currency: "USD",
        effective_from: "2026-06-01",
        note: "$2,800/wk / 6 days"
      }
    ]);
  });
});

describe("saveLaborCost", () => {
  it("upserts on the (location, effective_from) natural key", async () => {
    const upsert = vi.fn().mockResolvedValue({
      locationId: "default-location",
      effectiveFrom: "2026-06-01",
      dailyLaborCostCents: 46666.67,
      currency: "USD",
      note: "n"
    });
    const prisma = { inventoryLaborCost: { upsert } } as unknown as PrismaClient;

    await saveLaborCost(prisma, {
      daily_labor_cost_cents: 46666.67,
      currency: "USD",
      effective_from: "2026-06-01",
      note: "n"
    });

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          locationId_effectiveFrom: {
            locationId: "default-location",
            effectiveFrom: "2026-06-01"
          }
        },
        create: expect.objectContaining({
          locationId: "default-location",
          effectiveFrom: "2026-06-01",
          dailyLaborCostCents: 46666.67,
          currency: "USD",
          note: "n"
        }),
        update: expect.objectContaining({
          dailyLaborCostCents: 46666.67,
          currency: "USD",
          note: "n"
        })
      })
    );
  });

  it("coerces an omitted note to null (not undefined) for the column", async () => {
    const upsert = vi.fn().mockResolvedValue({});
    const prisma = { inventoryLaborCost: { upsert } } as unknown as PrismaClient;

    await saveLaborCost(prisma, {
      daily_labor_cost_cents: 100,
      currency: "USD",
      effective_from: "2026-06-01"
    });

    const arg = upsert.mock.calls[0]?.[0] as { create: { note: unknown } };
    expect(arg.create.note).toBeNull();
  });
});
