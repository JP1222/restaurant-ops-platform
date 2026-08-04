import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startInventoryItContext, type InventoryItContext } from "./fixture.js";

// Packs + barcodes (ADR-0737) end-to-end against a real Postgres: catalog CRUD, the
// barcode resolve endpoint, and the server-side pack conversion at PO receive. Replicates
// the canary suite's shape (own container, demo seed, app.inject).
describe("inventory packs + barcodes (ADR-0737, real Postgres)", () => {
  let ctx: InventoryItContext;

  beforeAll(async () => {
    ctx = await startInventoryItContext();
  });

  afterAll(async () => {
    await ctx?.stop();
  });

  const json = "application/json";

  async function items(): Promise<Array<{ id: string; on_hand: number; packs?: Array<{ id: string; label: string; base_qty_per_pack: number; is_purchase_default: boolean }> }>> {
    return (await ctx.app.inject({ method: "GET", url: "/api/inventory" })).json().items;
  }

  it("creates a pack, surfaces it in the dataset, enforces one default + unique label", async () => {
    const itemId = (await items())[0].id;
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/inventory/items/${itemId}/packs`,
      headers: { "content-type": json },
      payload: { label: "Case", base_qty_per_pack: 24, is_purchase_default: true },
    });
    expect(res.statusCode).toBe(201);
    const created = (res.json().item.packs as Array<{ label: string; base_qty_per_pack: number; is_purchase_default: boolean }>).find(
      (p) => p.label === "Case"
    );
    expect(created?.base_qty_per_pack).toBe(24);
    expect(created?.is_purchase_default).toBe(true);

    // Duplicate (vendor, label) → 409.
    const dup = await ctx.app.inject({
      method: "POST",
      url: `/api/inventory/items/${itemId}/packs`,
      headers: { "content-type": json },
      payload: { label: "Case", base_qty_per_pack: 12 },
    });
    expect(dup.statusCode).toBe(409);

    // Surfaces in the dataset read.
    const inDataset = (await items()).find((i) => i.id === itemId);
    expect(inDataset?.packs?.some((p) => p.label === "Case")).toBe(true);
  });

  it("maps a barcode to a pack and resolves it; unknown code → 404", async () => {
    const itemId = (await items())[0].id;
    const created = await ctx.app.inject({
      method: "POST",
      url: `/api/inventory/items/${itemId}/packs`,
      headers: { "content-type": json },
      payload: { label: "Bag", base_qty_per_pack: 8 },
    });
    const packId = (created.json().item.packs as Array<{ id: string; label: string }>).find((p) => p.label === "Bag")!.id;

    const code = "0123456789999";
    const bc = await ctx.app.inject({
      method: "POST",
      url: `/api/inventory/items/${itemId}/barcodes`,
      headers: { "content-type": json },
      payload: { code, pack_id: packId, source: "manufacturer" },
    });
    expect(bc.statusCode).toBe(201);

    const resolved = await ctx.app.inject({ method: "GET", url: `/api/inventory/barcode/${code}` });
    expect(resolved.statusCode).toBe(200);
    const body = resolved.json() as { item: { id: string }; pack: { id: string; base_qty_per_pack: number } | null };
    expect(body.item.id).toBe(itemId);
    expect(body.pack?.id).toBe(packId);
    expect(body.pack?.base_qty_per_pack).toBe(8);

    expect((await ctx.app.inject({ method: "GET", url: "/api/inventory/barcode/no-such-code" })).statusCode).toBe(404);
  });

  it("mints an internal YR- code, idempotent per (item, pack), and resolves it", async () => {
    const itemId = (await items())[0].id;
    const first = await ctx.app.inject({
      method: "POST",
      url: `/api/inventory/items/${itemId}/barcodes/mint`,
      headers: { "content-type": json },
      payload: {},
    });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json() as { item: { id: string }; code: string };
    expect(firstBody.code).toMatch(/^YR-\d{5}$/);
    expect(firstBody.item.id).toBe(itemId);

    // Idempotent: a second mint for the same (item, pack) returns the SAME code (no new row).
    const second = await ctx.app.inject({
      method: "POST",
      url: `/api/inventory/items/${itemId}/barcodes/mint`,
      headers: { "content-type": json },
      payload: {},
    });
    expect(second.statusCode).toBe(201);
    expect((second.json() as { code: string }).code).toBe(firstBody.code);

    // The minted code is registered (source=internal) and resolves to the item.
    const resolved = await ctx.app.inject({ method: "GET", url: `/api/inventory/barcode/${firstBody.code}` });
    expect(resolved.statusCode).toBe(200);
    expect((resolved.json() as { item: { id: string } }).item.id).toBe(itemId);
  });

  it("emits a 'finish setup' nudge when a barcode lands on a pack-less item, not when it has a pack (P5)", async () => {
    // A fresh item with no pack — the scan-to-register "skipped the case quantity" case.
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/inventory/items",
      headers: { "content-type": json },
      payload: { name: "Nudge Cups", category: "supplies", unit: "each", par_min: 0, par_max: 0 },
    });
    expect(created.statusCode).toBe(201);
    const itemId = (created.json() as { item: { id: string } }).item.id;

    const before = ctx.emittedNotifications.length;
    const bc = await ctx.app.inject({
      method: "POST",
      url: `/api/inventory/items/${itemId}/barcodes`,
      headers: { "content-type": json },
      payload: { code: "0999999999999", source: "manufacturer" },
    });
    expect(bc.statusCode).toBe(201);

    const nudge = ctx.emittedNotifications.slice(before).find((n) => n.dedupeKey === `inv:nopack:${itemId}`);
    expect(nudge).toBeDefined();
    expect(nudge?.severity).toBe("info");
    expect(nudge?.category).toBe("inv");

    // Give it a pack, then register another code → no new no-pack nudge (pack state is final at
    // barcode-save, so a packed item never fires).
    await ctx.app.inject({
      method: "POST",
      url: `/api/inventory/items/${itemId}/packs`,
      headers: { "content-type": json },
      payload: { label: "Sleeve", base_qty_per_pack: 50, is_purchase_default: true },
    });
    const afterPack = ctx.emittedNotifications.length;
    const bc2 = await ctx.app.inject({
      method: "POST",
      url: `/api/inventory/items/${itemId}/barcodes`,
      headers: { "content-type": json },
      payload: { code: "0999999999998", source: "manufacturer" },
    });
    expect(bc2.statusCode).toBe(201);
    expect(
      ctx.emittedNotifications.slice(afterPack).some((n) => n.dedupeKey === `inv:nopack:${itemId}`)
    ).toBe(false);
  });

  it("receives a PO line by pack — on_hand rises by qty × base_qty_per_pack", async () => {
    const itemId = (await items())[0].id;
    const before = (await items()).find((i) => i.id === itemId)!.on_hand;

    const created = await ctx.app.inject({
      method: "POST",
      url: `/api/inventory/items/${itemId}/packs`,
      headers: { "content-type": json },
      payload: { label: "Box6", base_qty_per_pack: 6 },
    });
    const packId = (created.json().item.packs as Array<{ id: string; label: string }>).find((p) => p.label === "Box6")!.id;

    const po = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/inventory/pos",
        headers: { "content-type": json },
        payload: { vendor: "Pack Vendor", lines: [{ sku: itemId, qty_ordered: 2, unit_cost_cents: 600 }] },
      })
    ).json().po as { id: string };

    const rec = await ctx.app.inject({
      method: "POST",
      url: `/api/inventory/pos/${po.id}/receive`,
      headers: { "content-type": json },
      payload: { who: "Tester", lines: [{ sku: itemId, qty: 2, pack_id: packId }] },
    });
    expect(rec.statusCode).toBe(200);

    const after = (await items()).find((i) => i.id === itemId)!.on_hand;
    expect(after).toBe(before + 12);
  });

  it("400s a receive line whose pack_id belongs to a different item", async () => {
    const list = await items();
    expect(list.length).toBeGreaterThanOrEqual(2);
    const itemA = list[0].id;
    const itemB = list[1].id;

    const created = await ctx.app.inject({
      method: "POST",
      url: `/api/inventory/items/${itemB}/packs`,
      headers: { "content-type": json },
      payload: { label: "Foreign", base_qty_per_pack: 10 },
    });
    const foreignPackId = (created.json().item.packs as Array<{ id: string; label: string }>).find(
      (p) => p.label === "Foreign"
    )!.id;

    const po = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/inventory/pos",
        headers: { "content-type": json },
        payload: { vendor: "X", lines: [{ sku: itemA, qty_ordered: 1, unit_cost_cents: 100 }] },
      })
    ).json().po as { id: string };

    const rec = await ctx.app.inject({
      method: "POST",
      url: `/api/inventory/pos/${po.id}/receive`,
      headers: { "content-type": json },
      payload: { who: "Tester", lines: [{ sku: itemA, qty: 1, pack_id: foreignPackId }] },
    });
    expect(rec.statusCode).toBe(400);
  });
});
