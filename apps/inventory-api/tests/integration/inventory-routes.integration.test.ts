import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyCounts,
  cancelPurchaseOrder,
  createPurchaseOrder,
  DEFAULT_LOCATION_ID,
  depleteFromSales,
  depleteSoldItems,
  getPurchaseOrder,
  PoStateConflictError,
  receivePurchaseOrder,
  recordWaste,
  runDepletionPoll,
  syncRecipesFromClover,
  syncRecipesFromSquare,
  updatePurchaseOrder,
  type SoldItemsFetcher,
} from "../../src/lib/inventory-store.js";
import { buildBomPlan, importBom, parseCsv } from "../../src/lib/bom-import.js";
import { startInventoryItContext, type InventoryItContext } from "./fixture.js";

// The canary: proves the whole Testcontainers seam end-to-end — container boot,
// `prisma migrate deploy`, demo seed, the real Fastify app over a real Postgres,
// reads + writes via app.inject(), and the truncate helper. Every other
// integration suite replicates this shape.
describe("inventory-api integration (real Postgres)", () => {
  let ctx: InventoryItContext;

  beforeAll(async () => {
    ctx = await startInventoryItContext();
  });

  afterAll(async () => {
    await ctx?.stop();
  });

  it("GET /api/inventory returns the seeded, contract-validated dataset", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/api/inventory" });
    expect(res.statusCode).toBe(200);

    const dataset = res.json();
    expect(Array.isArray(dataset.items)).toBe(true);
    expect(dataset.items.length).toBeGreaterThan(0);
    // assembleDataset only returns when the singletons exist — proves the read
    // path ran against real seeded rows, not a mock.
    expect(dataset.waste_settings).toBeTruthy();
  });

  it("POST /api/inventory/items/:id/toggle-86 flips the flag and persists it", async () => {
    const list = await ctx.app.inject({ method: "GET", url: "/api/inventory" });
    const target = list.json().items[0] as { id: string; flagged_86: boolean };
    const before = target.flagged_86;

    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/inventory/items/${target.id}/toggle-86`,
      headers: { "content-type": "application/json" },
      payload: { confirm: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().item.flagged_86).toBe(!before);

    // Re-read through the API to prove the write hit the database, not memory.
    const after = await ctx.app.inject({ method: "GET", url: "/api/inventory" });
    const reread = (after.json().items as Array<{ id: string; flagged_86: boolean }>).find(
      (i) => i.id === target.id,
    );
    expect(reread?.flagged_86).toBe(!before);

    // Toggle back — exercises the opposite branch of the toggle-86 producer (one
    // transition is a warn "86'd", the other an info "back in stock"); the flag
    // returns to its origin and the route still 200s.
    const back = await ctx.app.inject({
      method: "POST",
      url: `/api/inventory/items/${target.id}/toggle-86`,
      headers: { "content-type": "application/json" },
      payload: { confirm: true },
    });
    expect(back.statusCode).toBe(200);
    expect(back.json().item.flagged_86).toBe(before);
  });

  // ── Catalog management D1: par edit + archive (soft-delete) ───────────────────
  // Placed here, before the BOM-importer test adds ingredient rows, so the full
  // `GET /api/inventory` dataset is still the pristine seed (every category is a
  // valid contract enum) — the archive assertions read the whole dataset.
  it("PUT /api/inventory/items/:id/par edits par and persists to per-location state (catalog D1)", async () => {
    const target = await ctx.prisma.inventoryItem.findFirst({ orderBy: { id: "asc" } });
    expect(target).toBeTruthy();
    const id = target!.id;

    const put = await ctx.app.inject({
      method: "PUT",
      url: `/api/inventory/items/${id}/par`,
      headers: { "content-type": "application/json" },
      payload: { par_min: 7, par_max: 42 },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().item.par_min).toBe(7);
    expect(put.json().item.par_max).toBe(42);

    // par writes the per-LOCATION state row, NOT the brand-catalog item columns.
    const state = await ctx.prisma.inventoryItemState.findUnique({
      where: { locationId_itemId: { locationId: DEFAULT_LOCATION_ID, itemId: id } },
    });
    expect(state?.parMin).toBe(7);
    expect(state?.parMax).toBe(42);

    // par_max < par_min → 400.
    const bad = await ctx.app.inject({
      method: "PUT",
      url: `/api/inventory/items/${id}/par`,
      headers: { "content-type": "application/json" },
      payload: { par_min: 50, par_max: 10 },
    });
    expect(bad.statusCode).toBe(400);

    // Unknown item → 404.
    const missing = await ctx.app.inject({
      method: "PUT",
      url: "/api/inventory/items/does-not-exist/par",
      headers: { "content-type": "application/json" },
      payload: { par_min: 1, par_max: 2 },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("POST /api/inventory/items/:id/archive soft-deletes: hidden by default, visible via include=archived, restorable (catalog D1)", async () => {
    const target = await ctx.prisma.inventoryItem.findFirst({ orderBy: { id: "desc" } });
    expect(target).toBeTruthy();
    const id = target!.id;

    const archive = await ctx.app.inject({
      method: "POST",
      url: `/api/inventory/items/${id}/archive`,
      headers: { "content-type": "application/json" },
      payload: { archived: true },
    });
    expect(archive.statusCode).toBe(200);
    expect(archive.json().item.archived).toBe(true);

    // Excluded from the default dataset...
    const def = (await ctx.app.inject({ method: "GET", url: "/api/inventory" })).json();
    expect((def.items as Array<{ id: string }>).some((i) => i.id === id)).toBe(false);

    // ...but surfaced (flagged) with include=archived.
    const incl = (await ctx.app.inject({ method: "GET", url: "/api/inventory?include=archived" })).json();
    expect((incl.items as Array<{ id: string; archived: boolean }>).find((i) => i.id === id)?.archived).toBe(true);

    // The row is RETAINED (soft-delete), so recipe/PO/waste references stay intact.
    const row = await ctx.prisma.inventoryItem.findUnique({ where: { id } });
    expect(row).not.toBeNull();
    expect(row?.archivedAt).not.toBeNull();

    // Restore → back in the default dataset, archived=false.
    const restore = await ctx.app.inject({
      method: "POST",
      url: `/api/inventory/items/${id}/archive`,
      headers: { "content-type": "application/json" },
      payload: { archived: false },
    });
    expect(restore.statusCode).toBe(200);
    expect(restore.json().item.archived).toBe(false);
    const back = (await ctx.app.inject({ method: "GET", url: "/api/inventory" })).json();
    expect((back.items as Array<{ id: string }>).some((i) => i.id === id)).toBe(true);

    // Unknown item → 404.
    const missing = await ctx.app.inject({
      method: "POST",
      url: "/api/inventory/items/does-not-exist/archive",
      headers: { "content-type": "application/json" },
      payload: { archived: true },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("POST /api/inventory/items creates a catalog item (derives cost, 201) and 409s on a sku clash (catalog D1)", async () => {
    const before = (await ctx.app.inject({ method: "GET", url: "/api/inventory" })).json();
    const beforeCount = (before.items as unknown[]).length;

    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/inventory/items",
      headers: { "content-type": "application/json" },
      payload: {
        name: "Integration Test Sauce",
        sku: "ITG-SAUCE-1",
        category: "sweetener",
        unit: "ml",
        par_min: 100,
        par_max: 500,
        vendor: "Test Vendor",
        purchase_unit: "Jug",
        pack_qty: 1000,
        purchase_cost_cents: 1200,
      },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json().item;
    expect(created.name).toBe("Integration Test Sauce");
    expect(created.sku).toBe("ITG-SAUCE-1");
    expect(created.on_hand).toBe(0);
    expect(created.par_min).toBe(100);
    expect(created.archived).toBe(false);
    // cost derives from purchase_cost_cents / pack_qty = 1200 / 1000 = 1.2
    expect(created.cost_cents).toBeCloseTo(1.2, 5);

    // Appears in the active dataset.
    const after = (await ctx.app.inject({ method: "GET", url: "/api/inventory" })).json();
    expect((after.items as unknown[]).length).toBe(beforeCount + 1);
    expect((after.items as Array<{ id: string }>).some((i) => i.id === created.id)).toBe(true);

    // Duplicate sku → 409.
    const dup = await ctx.app.inject({
      method: "POST",
      url: "/api/inventory/items",
      headers: { "content-type": "application/json" },
      payload: { name: "Dup", sku: "ITG-SAUCE-1", category: "sweetener", unit: "ml", par_min: 0, par_max: 1 },
    });
    expect(dup.statusCode).toBe(409);

    // par_max < par_min → 400.
    const bad = await ctx.app.inject({
      method: "POST",
      url: "/api/inventory/items",
      headers: { "content-type": "application/json" },
      payload: { name: "Bad", category: "sweetener", unit: "ml", par_min: 9, par_max: 1 },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("crew security settings: defaults to allow-all, persists a PUT, and is readable open", async () => {
    // Default (no row yet) is an empty allowlist.
    const initial = await ctx.app.inject({ method: "GET", url: "/api/inventory/security-settings" });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().crew_ip_allowlist).toBe("");

    // Manager (bearer) sets it.
    const put = await ctx.app.inject({
      method: "PUT",
      url: "/api/admin/crew/security",
      headers: { "content-type": "application/json" },
      payload: { crew_ip_allowlist: "203.0.113.0/24\n198.51.100.7" },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().crew_ip_allowlist).toBe("203.0.113.0/24\n198.51.100.7");

    // Open read (crew-web polls this) reflects it.
    const open = await ctx.app.inject({ method: "GET", url: "/api/inventory/security-settings" });
    expect(open.json().crew_ip_allowlist).toBe("203.0.113.0/24\n198.51.100.7");

    // A malformed entry is rejected up front.
    const bad = await ctx.app.inject({
      method: "PUT",
      url: "/api/admin/crew/security",
      headers: { "content-type": "application/json" },
      payload: { crew_ip_allowlist: "not-an-ip" },
    });
    expect(bad.statusCode).toBe(400);
  });

  // Helper: create a throwaway catalog item and return it. The edit/photo tests
  // mutate their target, so they create their OWN item rather than touching a
  // seeded one — otherwise a later test (e.g. the "supplies" cold-start delete,
  // which relies on that category having no items) breaks on a shared mutation.
  async function createItem(name: string, category: string) {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/inventory/items",
      headers: { "content-type": "application/json" },
      payload: { name, category, unit: "each", par_min: 0, par_max: 1 },
    });
    expect(res.statusCode).toBe(201);
    return res.json().item as { id: string };
  }

  it("PUT /api/inventory/items/:id edits name + category + unit (floor edit item) and persists", async () => {
    const target = await createItem("Edit Target", "food");

    const res = await ctx.app.inject({
      method: "PUT",
      url: `/api/inventory/items/${target.id}`,
      headers: { "content-type": "application/json" },
      payload: { name: "Re-filed Item", category: "fruit", unit: "case" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().item).toMatchObject({ name: "Re-filed Item", category: "fruit", unit: "case" });

    // Re-read through the dataset to prove it hit the database.
    const after = (await ctx.app.inject({ method: "GET", url: "/api/inventory" })).json();
    const reread = (after.items as Array<{ id: string; name: string; category: string; unit: string }>).find(
      (i) => i.id === target.id,
    );
    expect(reread).toMatchObject({ name: "Re-filed Item", category: "fruit", unit: "case" });
  });

  it("item photo: PUT stores it, GET streams it, the dataset flags has_image, DELETE removes it", async () => {
    const target = await createItem("Photo Target", "food");

    // 1x1 transparent PNG.
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

    // Before: no image, dataset flag is false.
    const pre = (await ctx.app.inject({ method: "GET", url: "/api/inventory" })).json();
    expect((pre.items as Array<{ id: string; has_image?: boolean }>).find((i) => i.id === target.id)?.has_image).toBe(
      false,
    );
    const missing = await ctx.app.inject({ method: "GET", url: `/api/inventory/items/${target.id}/image` });
    expect(missing.statusCode).toBe(404);

    // Upload.
    const put = await ctx.app.inject({
      method: "PUT",
      url: `/api/inventory/items/${target.id}/image`,
      headers: { "content-type": "application/json" },
      payload: { content_type: "image/png", data_base64: pngBase64 },
    });
    expect(put.statusCode).toBe(204);

    // GET streams the bytes back with the stored content type.
    const get = await ctx.app.inject({ method: "GET", url: `/api/inventory/items/${target.id}/image` });
    expect(get.statusCode).toBe(200);
    expect(get.headers["content-type"]).toBe("image/png");
    expect(get.rawPayload.equals(Buffer.from(pngBase64, "base64"))).toBe(true);

    // The dataset now flags has_image without inlining the bytes.
    const withImg = (await ctx.app.inject({ method: "GET", url: "/api/inventory" })).json();
    const flagged = (withImg.items as Array<{ id: string; has_image?: boolean }>).find((i) => i.id === target.id);
    expect(flagged?.has_image).toBe(true);
    expect("data" in (flagged ?? {})).toBe(false);

    // Delete → flag clears, GET 404s again.
    const del = await ctx.app.inject({ method: "DELETE", url: `/api/inventory/items/${target.id}/image` });
    expect(del.statusCode).toBe(204);
    const after = (await ctx.app.inject({ method: "GET", url: "/api/inventory" })).json();
    expect(
      (after.items as Array<{ id: string; has_image?: boolean }>).find((i) => i.id === target.id)?.has_image,
    ).toBe(false);
  });

  it("PUT item photo 404s for an unknown item and 400s on a bad content type", async () => {
    const notFound = await ctx.app.inject({
      method: "PUT",
      url: "/api/inventory/items/does-not-exist/image",
      headers: { "content-type": "application/json" },
      payload: { content_type: "image/png", data_base64: "AAAA" },
    });
    expect(notFound.statusCode).toBe(404);

    const target = await ctx.prisma.inventoryItem.findFirst({ orderBy: { id: "asc" } });
    const badType = await ctx.app.inject({
      method: "PUT",
      url: `/api/inventory/items/${target!.id}/image`,
      headers: { "content-type": "application/json" },
      payload: { content_type: "image/gif", data_base64: "AAAA" },
    });
    expect(badType.statusCode).toBe(400);
  });

  it("POST /api/inventory/items re-seeds a missing canonical category before the FK insert (cold-start self-heal)", async () => {
    // Reproduce the cold-start gap: a canonical category row is absent (a fresh prod DB
    // has an EMPTY inventory_categories table while the dataset still serves the
    // defaults). "supplies" has no seeded items, so it can be removed without an FK
    // conflict. Without the fix, creating an item in it 400s (P2003); with it, the
    // create path upserts the canonical set first.
    await ctx.prisma.inventoryCategory.deleteMany({ where: { id: "supplies" } });

    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/inventory/items",
      headers: { "content-type": "application/json" },
      payload: { name: "Cleaning spray", category: "supplies", unit: "btl", par_min: 1, par_max: 4 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().item.category).toBe("supplies");

    // The create path re-created the FK target, and the full canonical set is present.
    const supplies = await ctx.prisma.inventoryCategory.findUnique({ where: { id: "supplies" } });
    expect(supplies).toBeTruthy();
    expect(await ctx.prisma.inventoryCategory.count()).toBe(8);
  });

  it("vendor CRUD: create (metrics default to 0), edit, archive/restore (catalog D2)", async () => {
    const create = await ctx.app.inject({
      method: "POST",
      url: "/api/inventory/vendors",
      headers: { "content-type": "application/json" },
      payload: {
        name: "Integration Test Vendor",
        type: "Specialty",
        contact: "Test Contact",
        phone: "(555) 555-1234",
        email: "test@vendor.example",
        terms: "Net 7",
        min_order_cents: 15000,
        cutoff: "9:00 PM CT",
        delivery_days: ["Mon", "Wed", "Fri"],
        categories: ["fruit"],
        preferred: true,
        tags: ["local"],
      },
    });
    expect(create.statusCode).toBe(201);
    const vendor = create.json().vendor;
    expect(vendor.name).toBe("Integration Test Vendor");
    expect(vendor.min_order_cents).toBe(15000);
    expect(vendor.preferred).toBe(true);
    expect(vendor.delivery_days).toEqual(["Mon", "Wed", "Fri"]);
    expect(vendor.archived).toBe(false);
    // Performance metrics default to 0/[] — derived from PO reconciliation, not entered.
    expect(vendor.fill_rate).toBe(0);
    expect(vendor.trend_4w).toEqual([]);

    // Appears in the active dataset.
    const ds1 = (await ctx.app.inject({ method: "GET", url: "/api/inventory" })).json();
    expect((ds1.vendors as Array<{ id: string }>).some((v) => v.id === vendor.id)).toBe(true);

    // Edit (full replace of editable fields; metrics untouched).
    const edit = await ctx.app.inject({
      method: "PUT",
      url: `/api/inventory/vendors/${vendor.id}`,
      headers: { "content-type": "application/json" },
      payload: { name: "Renamed Vendor", preferred: false },
    });
    expect(edit.statusCode).toBe(200);
    expect(edit.json().vendor.name).toBe("Renamed Vendor");
    expect(edit.json().vendor.preferred).toBe(false);

    // Archive → excluded by default, visible with include=archived.
    const arch = await ctx.app.inject({
      method: "POST",
      url: `/api/inventory/vendors/${vendor.id}/archive`,
      headers: { "content-type": "application/json" },
      payload: { archived: true },
    });
    expect(arch.statusCode).toBe(200);
    expect(arch.json().vendor.archived).toBe(true);

    const ds2 = (await ctx.app.inject({ method: "GET", url: "/api/inventory" })).json();
    expect((ds2.vendors as Array<{ id: string }>).some((v) => v.id === vendor.id)).toBe(false);

    const ds3 = (
      await ctx.app.inject({ method: "GET", url: "/api/inventory?include=archived" })
    ).json();
    expect(
      (ds3.vendors as Array<{ id: string; archived: boolean }>).find((v) => v.id === vendor.id)
        ?.archived,
    ).toBe(true);

    // Restore.
    const restore = await ctx.app.inject({
      method: "POST",
      url: `/api/inventory/vendors/${vendor.id}/archive`,
      headers: { "content-type": "application/json" },
      payload: { archived: false },
    });
    expect(restore.statusCode).toBe(200);
    expect(restore.json().vendor.archived).toBe(false);

    // 404 on unknown vendor.
    const missing = await ctx.app.inject({
      method: "PUT",
      url: "/api/inventory/vendors/does-not-exist",
      headers: { "content-type": "application/json" },
      payload: { name: "x" },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("POST /api/inventory/pos creates a submitted PO (derives total + lines) that is receivable (catalog D3)", async () => {
    const dataset = (await ctx.app.inject({ method: "GET", url: "/api/inventory" })).json();
    const item = (dataset.items as Array<{ id: string }>)[0];

    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/inventory/pos",
      headers: { "content-type": "application/json" },
      payload: {
        vendor: "Integration PO Vendor",
        expected: "2026-06-10",
        lines: [{ sku: item.id, qty_ordered: 10, unit_cost_cents: 250 }],
      },
    });
    expect(res.statusCode).toBe(201);
    const po = res.json().po;
    expect(po.vendor).toBe("Integration PO Vendor");
    expect(po.status).toBe("submitted");
    expect(po.lines).toBe(1);
    expect(po.total_cents).toBe(2500); // 10 * 250
    expect(po.line_items[0].sku).toBe(item.id);
    expect(po.line_items[0].qty_received).toBe(0);

    // Appears in the dataset PO summary, and the detail endpoint resolves it so the
    // floor can receive it via the existing flow.
    const after = (await ctx.app.inject({ method: "GET", url: "/api/inventory" })).json();
    expect((after.pos as Array<{ id: string }>).some((p) => p.id === po.id)).toBe(true);
    const detail = await ctx.app.inject({ method: "GET", url: `/api/inventory/pos/${po.id}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().line_items[0].sku).toBe(item.id);

    // Empty lines → 400.
    const bad = await ctx.app.inject({
      method: "POST",
      url: "/api/inventory/pos",
      headers: { "content-type": "application/json" },
      payload: { vendor: "X", lines: [] },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("POST /api/inventory/pos rejects a line whose sku is not in the catalog (400 unknown_skus, audit #6)", async () => {
    const real = (await ctx.app.inject({ method: "GET", url: "/api/inventory" })).json()
      .items[0] as { id: string };

    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/inventory/pos",
      headers: { "content-type": "application/json" },
      payload: {
        vendor: "Phantom Vendor",
        lines: [
          { sku: real.id, qty_ordered: 1, unit_cost_cents: 100 },
          { sku: "no-such-item", qty_ordered: 2, unit_cost_cents: 200 },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("unknown_skus");
    expect(res.json().skus).toContain("no-such-item");
    // The valid sku is NOT falsely reported, and no PO was created (validation runs
    // before the insert).
    expect(res.json().skus).not.toContain(real.id);
    const after = (await ctx.app.inject({ method: "GET", url: "/api/inventory" })).json();
    expect((after.pos as Array<{ vendor: string }>).some((p) => p.vendor === "Phantom Vendor")).toBe(
      false,
    );
  });

  it("POST /api/inventory/counts appends a count_adjust stock movement (ADR-0028 ledger)", async () => {
    const list = await ctx.app.inject({ method: "GET", url: "/api/inventory" });
    const target = list.json().items[0] as { id: string; on_hand: number };
    const newQty = target.on_hand + 5;

    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/inventory/counts",
      headers: { "content-type": "application/json" },
      payload: { updates: { [target.id]: newQty }, who: "Tester" },
    });
    expect(res.statusCode).toBe(200);

    // The dual-write recorded a signed delta with the count record as source_ref.
    const movements = await ctx.prisma.inventoryStockMovement.findMany({
      where: { itemId: target.id, reason: "count_adjust" },
    });
    expect(movements).toHaveLength(1);
    expect(movements[0]?.delta).toBe(5);
    expect(movements[0]?.sourceRef).toMatch(/^CT-/);
    expect(movements[0]?.actor).toBe("Tester");
  });

  it("POST /api/inventory/pos/:id/receive is idempotent — re-receiving does not double-apply (ADR-0028)", async () => {
    const dataset = (await ctx.app.inject({ method: "GET", url: "/api/inventory" })).json();
    const po = (dataset.pos as Array<{ id: string }>)[0];
    expect(po).toBeTruthy();

    const detail = (await ctx.app.inject({ method: "GET", url: `/api/inventory/pos/${po.id}` })).json();
    const lines = (detail.line_items as Array<{ sku: string; qty_ordered: number }>).map((li) => ({
      sku: li.sku,
      qty: li.qty_ordered,
    }));
    expect(lines.length).toBeGreaterThan(0);

    const receive = () =>
      ctx.app.inject({
        method: "POST",
        url: `/api/inventory/pos/${po.id}/receive`,
        headers: { "content-type": "application/json" },
        payload: { lines, who: "Tester" },
      });
    const movementCount = () =>
      ctx.prisma.inventoryStockMovement.count({
        where: { reason: "receive", sourceRef: { startsWith: `${po.id}:` } },
      });

    expect((await receive()).statusCode).toBe(200);
    const afterFirst = await movementCount();
    expect(afterFirst).toBeGreaterThan(0);

    // Re-receive the same PO: no new movements, on_hand untouched (the unique
    // (reason, source_ref, item_id) index + the pre-check make it a no-op).
    expect((await receive()).statusCode).toBe(200);
    expect(await movementCount()).toBe(afterFirst);
  });

  // ── Invoice-scan D2: ad-hoc receive (no PO) ───────────────────────────────────
  it("POST /api/inventory/receive (ad-hoc, no PO) bumps on_hand once and is idempotent per key", async () => {
    const item = await ctx.prisma.inventoryItem.findFirst({ orderBy: { id: "asc" } });
    expect(item).toBeTruthy();
    const id = item!.id;
    const onHand = async () =>
      (
        await ctx.prisma.inventoryItemState.findUnique({
          where: { locationId_itemId: { locationId: DEFAULT_LOCATION_ID, itemId: id } },
        })
      )?.onHand ?? item!.onHand;
    const before = await onHand();

    const receive = () =>
      ctx.app.inject({
        method: "POST",
        url: "/api/inventory/receive",
        headers: { "content-type": "application/json" },
        payload: {
          who: "Tester",
          idempotency_key: "adhoc-key-existing",
          vendor: "Acme",
          lines: [{ sku: id, qty: 5 }],
        },
      });

    const first = await receive();
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ received: 1, created: 0 });
    expect(await onHand()).toBe(before + 5);

    // Replay with the same key: whole-submission gate makes it a no-op.
    const second = await receive();
    expect(second.statusCode).toBe(201);
    expect(second.json()).toMatchObject({ received: 0, created: 0 });
    expect(await onHand()).toBe(before + 5);
  });

  it("POST /api/inventory/receive inline-creates a catalog item from a line with no sku (bootstrap from invoice)", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/inventory/receive",
      headers: { "content-type": "application/json" },
      payload: {
        who: "Tester",
        idempotency_key: "adhoc-key-create",
        vendor: "New Vendor Co",
        lines: [{ name: "Yuzu kosho paste", category: "sweetener", unit: "g", qty: 12, unit_cost_cents: 450 }],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ received: 1, created: 1 });

    const created = await ctx.prisma.inventoryItem.findFirst({
      where: { name: "Yuzu kosho paste" },
    });
    expect(created).toBeTruthy();
    expect(created!.categoryId).toBe("sweetener");
    expect(created!.unit).toBe("g");
    expect(created!.purchaseCostCents).toBe(450);
    const state = await ctx.prisma.inventoryItemState.findUnique({
      where: { locationId_itemId: { locationId: DEFAULT_LOCATION_ID, itemId: created!.id } },
    });
    expect(state?.onHand).toBe(12);
  });

  it("POST /api/inventory/receive seeds par on an inline-created item, clamping a sub-min max to 0 (no ceiling)", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/inventory/receive",
      headers: { "content-type": "application/json" },
      payload: {
        who: "Tester",
        idempotency_key: "adhoc-key-par",
        vendor: "Par Vendor",
        lines: [
          { name: "Par Good", category: "topping", unit: "ea", qty: 1, par_min: 3, par_max: 10 },
          { name: "Par Bad Max", category: "topping", unit: "ea", qty: 1, par_min: 8, par_max: 2 },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ received: 2, created: 2 });

    const good = await ctx.prisma.inventoryItem.findFirst({ where: { name: "Par Good" } });
    expect(good).toMatchObject({ parMin: 3, parMax: 10 });

    const bad = await ctx.prisma.inventoryItem.findFirst({ where: { name: "Par Bad Max" } });
    expect(bad).toMatchObject({ parMin: 8, parMax: 0 });
  });

  // ── Alias-learning: a confirmed receive teaches a (vendor, normalized)->item alias ──
  it("POST /api/inventory/receive learns a vendor alias and re-uses it on the next invoice", async () => {
    const item = await ctx.prisma.inventoryItem.findFirst({ orderBy: { id: "asc" } });
    expect(item).toBeTruthy();
    const id = item!.id;

    // First invoice from Sam's Club: a matched line carrying the vendor's printed text.
    const first = await ctx.app.inject({
      method: "POST",
      url: "/api/inventory/receive",
      headers: { "content-type": "application/json" },
      payload: {
        who: "Tester",
        idempotency_key: "alias-learn-1",
        vendor: "Sam's Club",
        lines: [
          {
            sku: id,
            qty: 3,
            unit_cost_cents: 420,
            description: "MEMBER'S MARK MILK 12 OZ",
            brand: "Member's Mark",
            pack: "12 oz",
          },
        ],
      },
    });
    expect(first.statusCode).toBe(201);

    // The alias is persisted under the shared (vendor, normalized) key, pointing at the item.
    const learned = await ctx.prisma.inventoryItemAlias.findUnique({
      where: {
        vendor_normalized: { vendor: "samsclub", normalized: "membersmarkmilk12oz" },
      },
    });
    expect(learned).toBeTruthy();
    expect(learned!.itemId).toBe(id);
    expect(learned!.brand).toBe("Member's Mark");
    expect(learned!.lastCostCents).toBe(420);
    expect(learned!.hits).toBe(1);
    // The readable vendor label is captured for the price view (ADR-0586 Phase 2B), while
    // the normalized key stays "samsclub".
    expect(learned!.vendorLabel).toBe("Sam's Club");

    // It rides the dataset so the web matchers can read it.
    const dataset = (await ctx.app.inject({ method: "GET", url: "/api/inventory" })).json();
    const inDataset = (dataset.item_aliases as Array<{ item_id: string; normalized: string }>).find(
      (a) => a.normalized === "membersmarkmilk12oz",
    );
    expect(inDataset?.item_id).toBe(id);

    // A second invoice with the same printed text (spacing/case differs) reinforces it
    // (hits++) rather than creating a duplicate — proving the normalized key is stable.
    const second = await ctx.app.inject({
      method: "POST",
      url: "/api/inventory/receive",
      headers: { "content-type": "application/json" },
      payload: {
        who: "Tester",
        idempotency_key: "alias-learn-2",
        vendor: "Sam's Club",
        lines: [{ sku: id, qty: 2, description: "Member's Mark Milk 12oz" }],
      },
    });
    expect(second.statusCode).toBe(201);
    const reinforced = await ctx.prisma.inventoryItemAlias.findUnique({
      where: {
        vendor_normalized: { vendor: "samsclub", normalized: "membersmarkmilk12oz" },
      },
    });
    expect(reinforced!.hits).toBe(2);
    // The bare second invoice carried no brand → the earlier-learned brand is preserved.
    expect(reinforced!.brand).toBe("Member's Mark");
    expect(
      await ctx.prisma.inventoryItemAlias.count({ where: { normalized: "membersmarkmilk12oz" } }),
    ).toBe(1);
  });

  it("POST /api/inventory/receive learns an alias for an inline-created item too", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/inventory/receive",
      headers: { "content-type": "application/json" },
      payload: {
        who: "Tester",
        idempotency_key: "alias-create-1",
        vendor: "Restaurant Depot",
        lines: [
          {
            name: "Oat Milk 1/2 gal",
            category: "dairy",
            unit: "ctn",
            qty: 6,
            unit_cost_cents: 510,
            description: "OATLY OAT MILK BARISTA 1/2 GAL",
            brand: "Oatly",
          },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ received: 1, created: 1 });

    const created = await ctx.prisma.inventoryItem.findFirst({
      where: { name: "Oat Milk 1/2 gal" },
    });
    expect(created).toBeTruthy();
    const alias = await ctx.prisma.inventoryItemAlias.findUnique({
      where: {
        vendor_normalized: {
          vendor: "restaurantdepot",
          normalized: "oatlyoatmilkbarista12gal",
        },
      },
    });
    expect(alias?.itemId).toBe(created!.id);
    expect(alias?.brand).toBe("Oatly");
  });

  // ── ADR-882: same product, different sizes → ONE item, many packs ──────────────────────────
  it("POST /api/inventory/receive groups same-product different-size lines into ONE item with many packs", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/inventory/receive",
      headers: { "content-type": "application/json" },
      payload: {
        who: "Tester",
        idempotency_key: "adhoc-grp-1",
        vendor: "Walmart",
        lines: [
          {
            name: "Haribo Goldbears",
            category: "topping",
            unit: "oz",
            item_group: "grp-goldbears",
            new_pack: { label: "28 oz bag", base_qty_per_pack: 28 },
            qty: 2,
            unit_cost_cents: 663,
            description: "GLDBEARS280Z",
          },
          {
            name: "Haribo Goldbears",
            category: "topping",
            unit: "oz",
            item_group: "grp-goldbears",
            new_pack: { label: "5 lb bag", base_qty_per_pack: 80 },
            qty: 1,
            unit_cost_cents: 1086,
            description: "GOLD BEARS 5LB",
          },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    // Two lines received, but only ONE item created (the second line reused the group).
    expect(res.json()).toMatchObject({ received: 2, created: 1 });

    const items = await ctx.prisma.inventoryItem.findMany({ where: { name: "Haribo Goldbears" } });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.categoryId).toBe("topping");
    expect(item.unit).toBe("oz");
    // Per-base cost from the first line's pack price: round(663 / 28) = 24c/oz whole-cent.
    expect(item.purchaseCostCents).toBe(24);

    // Two packs (sizes) on the one item, vendor-agnostic; the first created is the purchase default.
    const packs = await ctx.prisma.inventoryItemPack.findMany({
      where: { itemId: item.id },
      orderBy: { baseQtyPerPack: "asc" },
    });
    expect(packs.map((p) => p.baseQtyPerPack)).toEqual([28, 80]);
    expect(packs.every((p) => p.vendor === "")).toBe(true);
    expect(packs.find((p) => p.baseQtyPerPack === 28)!.isPurchaseDefault).toBe(true);

    // on_hand is the base-unit sum: 2*28 + 1*80 = 136 oz.
    const state = await ctx.prisma.inventoryItemState.findUnique({
      where: { locationId_itemId: { locationId: DEFAULT_LOCATION_ID, itemId: item.id } },
    });
    expect(state?.onHand).toBe(136);

    // Each learned alias remembers the specific PACK it booked into (the ADR-882 payoff).
    const alias28 = await ctx.prisma.inventoryItemAlias.findUnique({
      where: { vendor_normalized: { vendor: "walmart", normalized: "gldbears280z" } },
    });
    expect(alias28?.packId).toBe(packs.find((p) => p.baseQtyPerPack === 28)!.id);
  });

  it("POST /api/inventory/receive adds a new pack to an EXISTING item and is pack-idempotent", async () => {
    const item = await ctx.prisma.inventoryItem.findFirst({ orderBy: { id: "asc" } });
    const id = item!.id;
    const onHandOf = async () =>
      (
        await ctx.prisma.inventoryItemState.findUnique({
          where: { locationId_itemId: { locationId: DEFAULT_LOCATION_ID, itemId: id } },
        })
      )?.onHand ?? item!.onHand;
    const before = await onHandOf();

    const send = (k: string) =>
      ctx.app.inject({
        method: "POST",
        url: "/api/inventory/receive",
        headers: { "content-type": "application/json" },
        payload: {
          who: "Tester",
          idempotency_key: k,
          vendor: "Sysco",
          lines: [
            {
              sku: id,
              new_pack: { label: "adhoc-case-24", base_qty_per_pack: 24 },
              qty: 2,
              unit_cost_cents: 4800,
              description: "ADHOC NEWPACK CASE",
            },
          ],
        },
      });

    expect((await send("adhoc-newpack-1")).statusCode).toBe(201);
    // qty 2 * base_qty 24 = 48 base units booked.
    expect(await onHandOf()).toBe(before + 48);
    expect(
      await ctx.prisma.inventoryItemPack.count({ where: { itemId: id, label: "adhoc-case-24" } }),
    ).toBe(1);

    // A second receive of the SAME size (new key) REUSES the pack — no duplicate row — and books again.
    expect((await send("adhoc-newpack-2")).statusCode).toBe(201);
    expect(
      await ctx.prisma.inventoryItemPack.count({ where: { itemId: id, label: "adhoc-case-24" } }),
    ).toBe(1);
    expect(await onHandOf()).toBe(before + 96);
  });

  it("POST /api/inventory/receive rejects a line carrying both pack_id and new_pack (400)", async () => {
    const item = await ctx.prisma.inventoryItem.findFirst({ orderBy: { id: "asc" } });
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/inventory/receive",
      headers: { "content-type": "application/json" },
      payload: {
        who: "Tester",
        lines: [
          {
            sku: item!.id,
            pack_id: "some-existing-pack",
            new_pack: { label: "x", base_qty_per_pack: 2 },
            qty: 1,
          },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /api/inventory/waste is idempotent for a repeated idempotency_key (ADR-0028)", async () => {
    const dataset = (await ctx.app.inject({ method: "GET", url: "/api/inventory" })).json();
    const item = (dataset.items as Array<{ id: string; on_hand: number }>)[0];
    const reason = (dataset.waste_reasons as Array<{ id: string }>)[0].id;

    const onHandOf = async (id: string) =>
      (
        (await ctx.app.inject({ method: "GET", url: "/api/inventory" })).json().items as Array<{
          id: string;
          on_hand: number;
        }>
      ).find((i) => i.id === id)!.on_hand;

    const payload = {
      sku: item.id,
      qty: 1,
      reason,
      notes: "",
      photo: false,
      cost_cents: 0,
      who: "Tester",
      idempotency_key: "idem-waste-1",
    };
    const post = (p: Record<string, unknown> = payload) =>
      ctx.app.inject({
        method: "POST",
        url: "/api/inventory/waste",
        headers: { "content-type": "application/json" },
        payload: p,
      });

    const first = await post();
    expect(first.statusCode).toBe(200);
    const onHandAfterFirst = await onHandOf(item.id);

    // Replay the SAME key → same entry id, on_hand unchanged, still one waste row.
    const replay = await post();
    expect(replay.statusCode).toBe(200);
    expect(replay.json().entry.id).toBe(first.json().entry.id);
    expect(await onHandOf(item.id)).toBe(onHandAfterFirst);
    expect(
      await ctx.prisma.inventoryWasteEntry.count({ where: { idempotencyKey: "idem-waste-1" } }),
    ).toBe(1);

    // A fresh key is a distinct action → applies again (a second decrement).
    const second = await post({ ...payload, idempotency_key: "idem-waste-2" });
    expect(second.statusCode).toBe(200);
    expect(await onHandOf(item.id)).toBeLessThan(onHandAfterFirst);
  });

  it("POST /api/inventory/counts is idempotent for a repeated idempotency_key (ADR-0028)", async () => {
    const dataset = (await ctx.app.inject({ method: "GET", url: "/api/inventory" })).json();
    const item = (dataset.items as Array<{ id: string; on_hand: number }>)[0];
    const target = item.on_hand + 7;

    const payload = { updates: { [item.id]: target }, who: "Tester", idempotency_key: "idem-count-1" };
    const post = () =>
      ctx.app.inject({
        method: "POST",
        url: "/api/inventory/counts",
        headers: { "content-type": "application/json" },
        payload,
      });

    const first = await post();
    expect(first.statusCode).toBe(200);
    const countId = first.json().count.id as string;

    // Replay the SAME key → returns the prior count record, no second record/movement.
    const replay = await post();
    expect(replay.statusCode).toBe(200);
    expect(replay.json().count.id).toBe(countId);
    expect(
      await ctx.prisma.inventoryCountRecord.count({ where: { idempotencyKey: "idem-count-1" } }),
    ).toBe(1);
    expect(
      await ctx.prisma.inventoryStockMovement.count({
        where: { reason: "count_adjust", sourceRef: countId },
      }),
    ).toBe(1);
  });

  it("depleteFromSales expands a sold menu item into BOM movements and is idempotent (ADR-0028)", async () => {
    const recipe = await ctx.prisma.inventoryRecipe.findFirst({
      where: { lines: { some: {} } },
      include: { lines: true },
    });
    expect(recipe).toBeTruthy();

    const first = await depleteFromSales(ctx.prisma, [
      { lineItemId: "LI-test-1", recipeId: recipe!.id, quantity: 2 },
    ]);
    // toMatchObject (not toEqual): a seeded component sitting just above par can now
    // ride along an optional `lowStock` crossing (Phase 5c); this test asserts the
    // counts, not the crossing.
    expect(first).toMatchObject({ applied: 1, skipped: 0 });

    const movements = await ctx.prisma.inventoryStockMovement.findMany({
      where: { reason: "sale", sourceRef: "LI-test-1" },
    });
    expect(movements.length).toBe(recipe!.lines.length); // one per BOM component
    expect(movements.some((m) => m.delta < 0)).toBe(true); // real stock was consumed

    // Replay the same Clover line item → no double depletion.
    const second = await depleteFromSales(ctx.prisma, [
      { lineItemId: "LI-test-1", recipeId: recipe!.id, quantity: 2 },
    ]);
    expect(second).toEqual({ applied: 0, skipped: 1 });
    expect(
      await ctx.prisma.inventoryStockMovement.count({
        where: { reason: "sale", sourceRef: "LI-test-1" },
      }),
    ).toBe(movements.length);
  });

  it("depleteFromSales applies matched modifiers and aggregates a shared sku into one movement (ADR-0028)", async () => {
    const LOC = "mod-deplete-loc";
    // Two components via the suite-local helper (it ensures the canonical categories).
    const base = await createItem("Mod Tea Base", "food");
    const boba = await createItem("Mod Tapioca", "topping");

    // Recipe whose base BOM consumes 1 base + 1 tapioca, and whose "Extra Boba"
    // modifier ALSO draws tapioca (SAME sku as a base line — the aggregation case).
    // "No Boba" credits tapioca back but is not selected below.
    const recipe = await ctx.prisma.inventoryRecipe.create({
      data: {
        id: "mod-test-recipe",
        name: "Modifier Test Tea",
        category: "Milk Tea",
        sellCents: 500,
        lines: { create: [
          { sku: base.id, qty: 1 },
          { sku: boba.id, qty: 1 },
        ] },
        modifiers: { create: [
          { groupName: "Boba", optionName: "Extra Boba", sku: boba.id, qtyDelta: 2 },
          { groupName: "Boba", optionName: "No Boba", sku: boba.id, qtyDelta: -1 },
        ] },
      },
    });

    await applyCounts(ctx.prisma, { updates: { [base.id]: 100, [boba.id]: 100 }, who: "Seed" }, LOC);

    // Sell 1 with "Extra Boba": base −1; tapioca = base(1) + modifier(2) = −3, all in ONE movement.
    const res = await depleteFromSales(
      ctx.prisma,
      [{ lineItemId: "LI-mod-1", recipeId: recipe.id, quantity: 1, modifierNames: ["Extra Boba"] }],
      LOC,
    );
    expect(res).toEqual({ applied: 1, skipped: 0 });

    const baseState = await ctx.prisma.inventoryItemState.findUnique({
      where: { locationId_itemId: { locationId: LOC, itemId: base.id } },
    });
    const bobaState = await ctx.prisma.inventoryItemState.findUnique({
      where: { locationId_itemId: { locationId: LOC, itemId: boba.id } },
    });
    expect(baseState?.onHand).toBe(99);
    expect(bobaState?.onHand).toBe(97);

    // The base line + modifier on the SAME sku collapsed to exactly one `sale`
    // movement — a second create on (location, sale, LI-mod-1, tapioca) would hit
    // the unique index and 500. delta is the combined −3.
    const bobaMoves = await ctx.prisma.inventoryStockMovement.findMany({
      where: { locationId: LOC, reason: "sale", sourceRef: "LI-mod-1", itemId: boba.id },
    });
    expect(bobaMoves.length).toBe(1);
    expect(bobaMoves[0]!.delta).toBe(-3);

    // A sale with NO modifier selected depletes only the base BOM (tapioca −1, not −3).
    const res2 = await depleteFromSales(
      ctx.prisma,
      [{ lineItemId: "LI-mod-2", recipeId: recipe.id, quantity: 1 }],
      LOC,
    );
    expect(res2).toEqual({ applied: 1, skipped: 0 });
    const bobaAfter = await ctx.prisma.inventoryItemState.findUnique({
      where: { locationId_itemId: { locationId: LOC, itemId: boba.id } },
    });
    expect(bobaAfter?.onHand).toBe(96);
  });

  it("depleteFromSales surfaces a one-shot low-stock crossing when a sale takes an item below par (Phase 5c)", async () => {
    const LOC = "lowstock-sale-loc";
    // createItem hardcodes par 0 (and crossedBelowPar is a no-op at par 0), so make
    // the item directly with a positive par so a crossing can fire.
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/inventory/items",
      headers: { "content-type": "application/json" },
      payload: { name: "Low Stock Syrup", category: "food", unit: "each", par_min: 5, par_max: 20 },
    });
    expect(created.statusCode).toBe(201);
    const item = created.json().item as { id: string };

    // Recipe whose BOM consumes 2 of the item per sold unit.
    const recipe = await ctx.prisma.inventoryRecipe.create({
      data: {
        id: "lowstock-sale-recipe",
        name: "Low Stock Test Roll",
        category: "ROLLED ICE CREAM",
        sellCents: 500,
        lines: { create: [{ sku: item.id, qty: 2 }] },
      },
    });

    // Seed on_hand = 6 at LOC, just above par (5).
    await applyCounts(ctx.prisma, { updates: { [item.id]: 6 }, who: "Seed" }, LOC);

    // Sell 1 → consumes 2 → 6 → 4: the one-shot downward cross of par 5.
    const crossed = await depleteFromSales(
      ctx.prisma,
      [{ lineItemId: "LI-lowstock-1", recipeId: recipe.id, quantity: 1 }],
      LOC,
    );
    expect(crossed.applied).toBe(1);
    expect(crossed.lowStock).toEqual([
      { itemId: item.id, itemName: "Low Stock Syrup", onHand: 4, parMin: 5 },
    ]);

    // A second, different sale drops it further (4 → 2) but does NOT re-fire — it was
    // already below par. With no crossings, `lowStock` is omitted entirely (no spam).
    const again = await depleteFromSales(
      ctx.prisma,
      [{ lineItemId: "LI-lowstock-2", recipeId: recipe.id, quantity: 1 }],
      LOC,
    );
    expect(again.applied).toBe(1);
    expect(again.lowStock).toBeUndefined();
  });

  it("depleteSoldItems resolves Clover item names to recipes and reports unmatched (ADR-0028)", async () => {
    const recipe = await ctx.prisma.inventoryRecipe.findFirst({
      where: { lines: { some: {} } },
      include: { lines: true },
    });
    expect(recipe).toBeTruthy();

    const { result, unmatched } = await depleteSoldItems(ctx.prisma, [
      { lineItemId: "LI-name-1", itemName: recipe!.name, quantity: 1 },
      { lineItemId: "LI-name-2", itemName: "Definitely Not A Real Menu Item", quantity: 1 },
    ]);

    expect(result.applied).toBe(1);
    expect(unmatched).toEqual(["Definitely Not A Real Menu Item"]);
    expect(
      await ctx.prisma.inventoryStockMovement.count({
        where: { reason: "sale", sourceRef: "LI-name-1" },
      }),
    ).toBe(recipe!.lines.length);
  });

  it("syncRecipesFromClover upserts recipes; depletion then resolves by clover_item_id (ADR-0028)", async () => {
    const created = await syncRecipesFromClover(ctx.prisma, [
      { cloverItemId: "CLV-TEST-1", name: "Synced Test Roll", category: "ROLLED ICE CREAM", priceCents: 699 },
    ]);
    expect(created).toEqual({ created: 1, updated: 0 });

    const recipe = await ctx.prisma.inventoryRecipe.findUnique({ where: { cloverItemId: "CLV-TEST-1" } });
    expect(recipe?.id).toBe("CLV-TEST-1"); // synced recipe id == clover item id
    expect(recipe?.sellCents).toBe(699);

    // Re-sync is idempotent — updates the same row, never duplicates.
    const resync = await syncRecipesFromClover(ctx.prisma, [
      { cloverItemId: "CLV-TEST-1", name: "Synced Test Roll v2", category: "ROLLED ICE CREAM", priceCents: 749 },
    ]);
    expect(resync).toEqual({ created: 0, updated: 1 });
    expect(
      (await ctx.prisma.inventoryRecipe.findUnique({ where: { cloverItemId: "CLV-TEST-1" } }))?.sellCents,
    ).toBe(749);

    // A sale carrying the clover_item_id resolves by it even when the name wouldn't match.
    const { result, unmatched } = await depleteSoldItems(ctx.prisma, [
      { lineItemId: "LI-clv-1", cloverItemId: "CLV-TEST-1", itemName: "totally-different-name", quantity: 1 },
    ]);
    expect(unmatched).toEqual([]);
    expect(result.applied).toBe(1);
  });

  it("syncRecipesFromSquare namespaces the id as square:{id}; depletion resolves by square_catalog_item_id (store #2)", async () => {
    const created = await syncRecipesFromSquare(ctx.prisma, [
      { squareCatalogObjectId: "SQ-TEST-1", name: "Synced Square Roll", category: "ROLLED ICE CREAM", priceCents: 699 },
    ]);
    expect(created).toEqual({ created: 1, updated: 0 });

    const recipe = await ctx.prisma.inventoryRecipe.findUnique({
      where: { squareCatalogObjectId: "SQ-TEST-1" },
    });
    // The one Square-vs-Clover difference: the PK is namespaced so it can never
    // collide with a Clover recipe whose id IS the bare item id; the bare id lives
    // in squareCatalogObjectId (the depletion join key).
    expect(recipe?.id).toBe("square:SQ-TEST-1");
    expect(recipe?.squareCatalogObjectId).toBe("SQ-TEST-1");
    expect(recipe?.cloverItemId).toBeNull();
    expect(recipe?.sellCents).toBe(699);

    // Re-sync is idempotent — updates the same row (matched by square_catalog_item_id), never duplicates.
    const resync = await syncRecipesFromSquare(ctx.prisma, [
      { squareCatalogObjectId: "SQ-TEST-1", name: "Synced Square Roll v2", category: "ROLLED ICE CREAM", priceCents: 749 },
    ]);
    expect(resync).toEqual({ created: 0, updated: 1 });
    expect(
      (await ctx.prisma.inventoryRecipe.findUnique({ where: { squareCatalogObjectId: "SQ-TEST-1" } }))?.sellCents,
    ).toBe(749);

    // A Square sale carrying the square_catalog_item_id resolves by it even when the
    // name wouldn't match — proving the clover→square→name join reaches the square map.
    const { result, unmatched } = await depleteSoldItems(ctx.prisma, [
      { lineItemId: "LI-sq-1", squareCatalogObjectId: "SQ-TEST-1", itemName: "totally-different-name", quantity: 1 },
    ]);
    expect(unmatched).toEqual([]);
    expect(result.applied).toBe(1);
  });

  it("runDepletionPoll depletes from an injected source and advances the watermark (ADR-0028)", async () => {
    const recipe = await ctx.prisma.inventoryRecipe.findFirst({
      where: { lines: { some: {} } },
      include: { lines: true },
    });
    expect(recipe).toBeTruthy();

    // Injected sales source: one sold item before any cursor, nothing after it.
    const fetch: SoldItemsFetcher = async (cursor) =>
      cursor === null
        ? {
            soldItems: [{ lineItemId: "LI-poll-1", itemName: recipe!.name, quantity: 1 }],
            nextCursor: "cursor-1",
          }
        : { soldItems: [], nextCursor: cursor };

    const first = await runDepletionPoll(ctx.prisma, fetch);
    expect(first.applied).toBe(1);
    expect(first.cursor).toBe("cursor-1");
    expect(
      (await ctx.prisma.inventoryDepletionCursor.findUnique({ where: { id: "singleton" } }))?.cursor,
    ).toBe("cursor-1"); // watermark persisted
    expect(
      await ctx.prisma.inventoryStockMovement.count({
        where: { reason: "sale", sourceRef: "LI-poll-1" },
      }),
    ).toBe(recipe!.lines.length);

    // Second poll resumes from the stored cursor → source returns nothing → no-op.
    const second = await runDepletionPoll(ctx.prisma, fetch);
    expect(second.applied).toBe(0);
    expect(second.cursor).toBe("cursor-1");
  });

  it("BOM importer: CSV → ingredients + recipes + BOMs, then a sale depletes them (ADR-0028)", async () => {
    const csv = [
      "include? (Y/N),clover_item_id,menu_item,category,price_$,cup_qty,lid_qty,spoon_qty,straw_qty,napkin_qty,main/base (oz or g),other_ingredients (name:qty; ...)",
      'Y,CLV-IMP-1,Import Test Smoothie,SMOOTHIE,5.99,1,1,,1,,smoothie base:2oz,"mango puree:4oz; whole milk:6oz"',
      "N,CLV-SKIP,Should Be Skipped,JUNK,0,9,9,9,9,9,,",
    ].join("\n");

    const plan = buildBomPlan(parseCsv(csv));
    // only the include=Y row becomes a recipe
    expect(plan.recipes.map((r) => r.cloverItemId)).toEqual(["CLV-IMP-1"]);
    // distinct ingredients: Cup, Lid, Straw, smoothie base, mango puree, whole milk
    expect(plan.ingredients.length).toBe(6);

    const result = await importBom(ctx.prisma, plan);
    expect(result.recipes.created).toBe(1);
    expect(result.ingredientsCreated).toBe(6);
    expect(result.bomsSet).toBe(1);

    const recipe = await ctx.prisma.inventoryRecipe.findUnique({
      where: { cloverItemId: "CLV-IMP-1" },
      include: { lines: true },
    });
    expect(recipe?.lines.length).toBe(6);

    // A Clover sale of it depletes all 6 components (resolved by clover_item_id).
    const { result: dep, unmatched } = await depleteSoldItems(ctx.prisma, [
      { lineItemId: "LI-imp-1", cloverItemId: "CLV-IMP-1", itemName: "ignored", quantity: 1 },
    ]);
    expect(unmatched).toEqual([]);
    expect(dep.applied).toBe(1);
    expect(
      await ctx.prisma.inventoryStockMovement.count({ where: { reason: "sale", sourceRef: "LI-imp-1" } }),
    ).toBe(6);
  });

  it("POST /api/inventory/recipes creates a recipe header (empty BOM), then it's editable via PUT", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/inventory/recipes",
      headers: { "content-type": "application/json" },
      payload: { name: "Taro Milk Tea", category: "Milk Tea", sell_cents: 650 },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json();
    expect(created.id).toBeTruthy();
    expect(created.name).toBe("Taro Milk Tea");
    expect(created.category).toBe("Milk Tea");
    expect(created.sell_cents).toBe(650);
    expect(created.lines).toEqual([]);
    expect(created.modifiers).toEqual([]);

    // The freshly-created recipe is immediately editable through the existing editor PUT.
    const item = await ctx.prisma.inventoryItem.findFirst({ orderBy: { id: "asc" } });
    const put = await ctx.app.inject({
      method: "PUT",
      url: `/api/inventory/recipes/${created.id}`,
      headers: { "content-type": "application/json" },
      payload: { lines: [{ sku: item!.id, qty: 2 }], modifiers: [] },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().lines).toEqual([{ sku: item!.id, qty: 2 }]);
  });

  it("GET/PUT /api/inventory/recipes/:id reads + saves base lines + signed modifier consumption (ADR-0028 editor S1)", async () => {
    // A seeded recipe with at least one base line, plus an ingredient sku to consume.
    const seeded = await ctx.prisma.inventoryRecipe.findFirst({
      where: { lines: { some: {} } },
      include: { lines: true },
    });
    expect(seeded).toBeTruthy();
    const sku = seeded!.lines[0]!.sku;

    // GET returns the editor detail shape (base lines + modifiers + clover link).
    const get = await ctx.app.inject({ method: "GET", url: `/api/inventory/recipes/${seeded!.id}` });
    expect(get.statusCode).toBe(200);
    const detail = get.json();
    expect(detail.id).toBe(seeded!.id);
    expect(Array.isArray(detail.lines)).toBe(true);
    expect(Array.isArray(detail.modifiers)).toBe(true);
    expect("clover_item_id" in detail).toBe(true);

    // PUT is a full-set replace of base lines + per-modifier consumption. "No Boba"
    // carries a NEGATIVE delta (credits stock back) — proves signed qty round-trips.
    const put = await ctx.app.inject({
      method: "PUT",
      url: `/api/inventory/recipes/${seeded!.id}`,
      headers: { "content-type": "application/json" },
      payload: {
        lines: [{ sku, qty: 3 }],
        modifiers: [
          { group: "Boba", option: "Extra Boba", sku, qty: 2 },
          { group: "Boba", option: "No Boba", sku, qty: -2 },
        ],
      },
    });
    expect(put.statusCode).toBe(200);
    const saved = put.json();
    expect(saved.lines).toEqual([{ sku, qty: 3 }]);
    expect(saved.modifiers).toHaveLength(2);
    expect(
      (saved.modifiers as Array<{ option: string; qty: number }>).find((m) => m.option === "No Boba")?.qty,
    ).toBe(-2);

    // Re-read proves it persisted to Postgres and is a full-set replace.
    const reread = (
      await ctx.app.inject({ method: "GET", url: `/api/inventory/recipes/${seeded!.id}` })
    ).json();
    expect(reread.lines).toEqual([{ sku, qty: 3 }]);
    expect(reread.modifiers).toHaveLength(2);

    // Unknown recipe → 404.
    const missing = await ctx.app.inject({ method: "GET", url: "/api/inventory/recipes/does-not-exist" });
    expect(missing.statusCode).toBe(404);
  });

  it("PUT /api/inventory/items/:id edits the purchase->usage conversion and re-derives sub-cent cost (S3)", async () => {
    // Pick a seeded item straight from the DB (this exercises the item editor, not
    // the full-dataset read).
    const target = await ctx.prisma.inventoryItem.findFirst({ orderBy: { id: "asc" } });
    expect(target).toBeTruthy();
    const id = target!.id;

    // Buy a Case of 1,000 for $52.00 -> per-usage cost derives to 5.2 cents (a Float
    // column now; the old Int would have rounded this to 5).
    const put = await ctx.app.inject({
      method: "PUT",
      url: `/api/inventory/items/${id}`,
      headers: { "content-type": "application/json" },
      payload: { purchase_unit: "Case", pack_qty: 1000, purchase_cost_cents: 5200, vendor: "Webstaurant" }
    });
    expect(put.statusCode).toBe(200);
    const saved = put.json().item;
    expect(saved.purchase_unit).toBe("Case");
    expect(saved.pack_qty).toBe(1000);
    expect(saved.purchase_cost_cents).toBe(5200);
    expect(saved.cost_cents).toBeCloseTo(5.2, 5);

    // Persisted to Postgres with sub-cent precision (Float column, not rounded to 5).
    const row = await ctx.prisma.inventoryItem.findUnique({ where: { id } });
    expect(row?.costCents).toBeCloseTo(5.2, 5);
    expect(row?.purchaseUnit).toBe("Case");

    // Editing only the name must NOT wipe the derived cost (purchase price absent).
    const renamed = await ctx.app.inject({
      method: "PUT",
      url: `/api/inventory/items/${id}`,
      headers: { "content-type": "application/json" },
      payload: { name: "Renamed Item" }
    });
    expect(renamed.statusCode).toBe(200);
    const row2 = await ctx.prisma.inventoryItem.findUnique({ where: { id } });
    expect(row2?.name).toBe("Renamed Item");
    expect(row2?.costCents).toBeCloseTo(5.2, 5);

    // Unknown item → 404.
    const missingItem = await ctx.app.inject({
      method: "PUT",
      url: "/api/inventory/items/does-not-exist",
      headers: { "content-type": "application/json" },
      payload: { vendor: "x" }
    });
    expect(missingItem.statusCode).toBe(404);
  });

  it("POST /api/inventory/sync-sales reports 503 when the analytics feed isn't configured (S4b)", async () => {
    // The integration fixture doesn't wire analytics (no INTERNAL_ANALYTICS_API_URL
    // / ANALYTICS_ADMIN_TOKEN / CLOVER_MERCHANT_ID), so the manual sync trigger must
    // report not-configured rather than crash or attempt a fetch.
    const res = await ctx.app.inject({ method: "POST", url: "/api/inventory/sync-sales" });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/not configured/i);
  });

  // ── Per-location idempotency (ADR-0018 Phase 4, #422 / #426 / #427) ──────────
  // The stock-movement unique key is (location_id, reason, source_ref, item_id),
  // so the SAME (reason, source_ref, item_id) is applied at most once PER LOCATION
  // and the two stores keep independent histories.

  it("depleteFromSales applies the SAME Clover line item independently in two locations (#422/#427)", async () => {
    const LOC_B = "location-b";
    const recipe = await ctx.prisma.inventoryRecipe.findFirst({
      where: { lines: { some: {} } },
      include: { lines: true },
    });
    expect(recipe).toBeTruthy();

    const lineItemId = "LI-shared-multiloc";
    const line = { lineItemId, recipeId: recipe!.id, quantity: 1 };

    // Location A depletes first. toMatchObject: an optional Phase-5c `lowStock`
    // crossing may ride along on a seeded component near par (this test is about the
    // per-location apply/skip counts, not the crossing).
    const a = await depleteFromSales(ctx.prisma, [line], DEFAULT_LOCATION_ID);
    expect(a).toMatchObject({ applied: 1, skipped: 0 });

    // Location B's legitimate depletion of the SAME merchant-wide line item is NOT
    // blocked by A's rows (pre-fix: location B found A's movement and skipped).
    const b = await depleteFromSales(ctx.prisma, [line], LOC_B);
    expect(b).toMatchObject({ applied: 1, skipped: 0 });

    // Each location holds its own `sale` movements for this source_ref — no cross-
    // store collision, and the row count is per-location BOM size.
    const aMoves = await ctx.prisma.inventoryStockMovement.findMany({
      where: { locationId: DEFAULT_LOCATION_ID, reason: "sale", sourceRef: lineItemId },
    });
    const bMoves = await ctx.prisma.inventoryStockMovement.findMany({
      where: { locationId: LOC_B, reason: "sale", sourceRef: lineItemId },
    });
    expect(aMoves.length).toBe(recipe!.lines.length);
    expect(bMoves.length).toBe(recipe!.lines.length);

    // Replaying the line within a SINGLE location is still idempotent (per-store).
    const replay = await depleteFromSales(ctx.prisma, [line], LOC_B);
    expect(replay).toEqual({ applied: 0, skipped: 1 });
    expect(
      await ctx.prisma.inventoryStockMovement.count({
        where: { locationId: LOC_B, reason: "sale", sourceRef: lineItemId },
      }),
    ).toBe(recipe!.lines.length);
  });

  it("PO receive applies the SAME PO line independently in two locations (#426)", async () => {
    const LOC_A = "loc-recv-a";
    const LOC_B = "loc-recv-b";
    const sku = (await ctx.prisma.inventoryItem.findFirst({ orderBy: { id: "asc" } }))!.id;

    // Two distinct POs — one per store — that share the SAME source_ref shape
    // (`${poId}:${sku}`). Same PO id across stores would collide on the PK, so
    // each store gets its own PO id; the point under test is that the receive
    // ledger no longer collapses them into one row across locations.
    for (const [poId, loc] of [["PO-RECV-A", LOC_A], ["PO-RECV-B", LOC_B]] as const) {
      await ctx.prisma.inventoryPurchaseOrder.create({
        data: {
          id: poId,
          locationId: loc,
          vendor: "Acme",
          placed: "2026-06-03",
          expected: "2026-06-04",
          lines: 1,
          status: "in-transit",
          totalCents: 1000,
        },
      });
      await ctx.prisma.inventoryPoLine.create({
        data: { locationId: loc, poId, sku, qtyOrdered: 5, qtyReceived: 0 },
      });
    }

    const submission = { lines: [{ sku, qty: 5 }], who: "Tester" };
    const ra = await receivePurchaseOrder(ctx.prisma, "PO-RECV-A", submission, LOC_A);
    const rb = await receivePurchaseOrder(ctx.prisma, "PO-RECV-B", submission, LOC_B);
    expect(ra?.status).toBe("received");
    expect(rb?.status).toBe("received");

    // Each location recorded its own `receive` movement — the location-scoped key
    // means B's receive is not deduped against A's (pre-fix: the narrow key would
    // have collapsed them or blocked B).
    expect(
      await ctx.prisma.inventoryStockMovement.count({
        where: { locationId: LOC_A, reason: "receive", sourceRef: `PO-RECV-A:${sku}` },
      }),
    ).toBe(1);
    expect(
      await ctx.prisma.inventoryStockMovement.count({
        where: { locationId: LOC_B, reason: "receive", sourceRef: `PO-RECV-B:${sku}` },
      }),
    ).toBe(1);

    // Re-receiving in location A is still idempotent (per-store) — no second row.
    const replay = await receivePurchaseOrder(ctx.prisma, "PO-RECV-A", submission, LOC_A);
    expect(replay?.status).toBe("received");
    expect(
      await ctx.prisma.inventoryStockMovement.count({
        where: { locationId: LOC_A, reason: "receive", sourceRef: `PO-RECV-A:${sku}` },
      }),
    ).toBe(1);
  });

  it("the unique constraint permits identical (reason, source_ref, item_id) across locations but blocks duplicates within one (#422/#426)", async () => {
    const itemId = (await ctx.prisma.inventoryItem.findFirst({ orderBy: { id: "asc" } }))!.id;
    const shared = { itemId, delta: -1, reason: "sale", sourceRef: "SR-constraint-probe", actor: "test" };

    // Same key in two different locations → both inserts succeed.
    await ctx.prisma.inventoryStockMovement.create({
      data: { ...shared, locationId: "loc-x" },
    });
    await ctx.prisma.inventoryStockMovement.create({
      data: { ...shared, locationId: "loc-y" },
    });
    expect(
      await ctx.prisma.inventoryStockMovement.count({ where: { sourceRef: "SR-constraint-probe" } }),
    ).toBe(2);

    // A duplicate WITHIN the same location violates the unique index (P2002).
    await expect(
      ctx.prisma.inventoryStockMovement.create({ data: { ...shared, locationId: "loc-x" } }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("getPurchaseOrder is location-scoped: a PO in location A is invisible to location B (#428/#429)", async () => {
    const sku = (await ctx.prisma.inventoryItem.findFirst({ orderBy: { id: "asc" } }))!.id;
    await ctx.prisma.inventoryPurchaseOrder.create({
      data: {
        id: "PO-SCOPED-A",
        locationId: "scope-a",
        vendor: "Acme",
        placed: "2026-06-03",
        expected: "2026-06-04",
        lines: 1,
        status: "in-transit",
        totalCents: 2000,
      },
    });
    await ctx.prisma.inventoryPoLine.create({
      data: { locationId: "scope-a", poId: "PO-SCOPED-A", sku, qtyOrdered: 3, qtyReceived: 0 },
    });

    // Readable from its own store.
    const own = await getPurchaseOrder(ctx.prisma, "PO-SCOPED-A", "scope-a");
    expect(own?.id).toBe("PO-SCOPED-A");

    // A location-B caller (or the GET /pos/:id route resolving `?location=scope-b`)
    // gets null → the route 404s, closing the cross-store PO read.
    expect(await getPurchaseOrder(ctx.prisma, "PO-SCOPED-A", "scope-b")).toBeNull();

    // End-to-end through the route: ?location=scope-b → 404, ?location=scope-a → 200.
    const denied = await ctx.app.inject({
      method: "GET",
      url: "/api/inventory/pos/PO-SCOPED-A?location=scope-b",
    });
    expect(denied.statusCode).toBe(404);
    const allowed = await ctx.app.inject({
      method: "GET",
      url: "/api/inventory/pos/PO-SCOPED-A?location=scope-a",
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().id).toBe("PO-SCOPED-A");
  });

  it("createPurchaseOrder persists per-line unit cost, round-tripped via GET detail (P1 PO edit)", async () => {
    const sku = (await ctx.prisma.inventoryItem.findFirst({ orderBy: { id: "asc" } }))!.id;
    const created = await createPurchaseOrder(
      ctx.prisma,
      { vendor: "Acme", expected: "2026-07-01", lines: [{ sku, qty_ordered: 4, unit_cost_cents: 250 }] },
      "po-cost-loc",
    );
    expect(created.line_items[0]?.unit_cost_cents).toBe(250);
    expect(created.total_cents).toBe(1000);

    // The cost survives a fresh read (not just the create's in-memory return).
    const fetched = await getPurchaseOrder(ctx.prisma, created.id, "po-cost-loc");
    expect(fetched?.line_items[0]?.unit_cost_cents).toBe(250);
  });

  it("updatePurchaseOrder replaces lines, recomputes the total, and logs an activity entry (P1)", async () => {
    const items = await ctx.prisma.inventoryItem.findMany({ orderBy: { id: "asc" }, take: 2 });
    const [a, b] = items;
    const created = await createPurchaseOrder(
      ctx.prisma,
      { vendor: "Acme", lines: [{ sku: a!.id, qty_ordered: 2, unit_cost_cents: 100 }] },
      "po-edit-loc",
    );

    const updated = await updatePurchaseOrder(
      ctx.prisma,
      created.id,
      {
        vendor: "Acme Foods",
        expected: "2026-07-15",
        lines: [
          { sku: a!.id, qty_ordered: 3, unit_cost_cents: 120 },
          { sku: b!.id, qty_ordered: 1, unit_cost_cents: 500 },
        ],
      },
      "Maya",
      "po-edit-loc",
    );
    expect(updated?.vendor).toBe("Acme Foods");
    expect(updated?.expected).toBe("2026-07-15");
    expect(updated?.line_items).toHaveLength(2);
    // 3*120 + 1*500 = 860.
    expect(updated?.total_cents).toBe(860);
    expect(updated?.lines).toBe(2);

    // The old line set is fully replaced (no orphan rows), and the persisted
    // costs round-trip.
    const fetched = await getPurchaseOrder(ctx.prisma, created.id, "po-edit-loc");
    expect(fetched?.line_items.map((l) => l.sku).sort()).toEqual([a!.id, b!.id].sort());
    const lineA = fetched?.line_items.find((l) => l.sku === a!.id);
    expect(lineA?.qty_ordered).toBe(3);
    expect(lineA?.unit_cost_cents).toBe(120);

    const activity = await ctx.prisma.inventoryActivityEntry.findFirst({
      where: { locationId: "po-edit-loc", action: "edited", what: { contains: created.id } },
    });
    expect(activity?.who).toBe("Maya");
  });

  it("updatePurchaseOrder is location-scoped and 404s a missing PO; the route maps that to 404", async () => {
    const sku = (await ctx.prisma.inventoryItem.findFirst({ orderBy: { id: "asc" } }))!.id;
    const created = await createPurchaseOrder(
      ctx.prisma,
      { vendor: "Acme", lines: [{ sku, qty_ordered: 1, unit_cost_cents: 100 }] },
      "po-scope-edit",
    );
    // Wrong location → invisible → null.
    expect(
      await updatePurchaseOrder(
        ctx.prisma,
        created.id,
        { vendor: "X", lines: [{ sku, qty_ordered: 1, unit_cost_cents: 100 }] },
        "Tester",
        "other-loc",
      ),
    ).toBeNull();
    // Through the route (bearer-less in test app): wrong ?location → 404.
    const res = await ctx.app.inject({
      method: "PUT",
      url: `/api/inventory/pos/${created.id}?location=other-loc`,
      payload: { vendor: "X", lines: [{ sku, qty_ordered: 1, unit_cost_cents: 100 }] },
    });
    expect(res.statusCode).toBe(404);
  });

  it("a received PO can't be edited or cancelled (409 po_not_editable); cancel hides it from the dataset (P1)", async () => {
    const sku = (await ctx.prisma.inventoryItem.findFirst({ orderBy: { id: "asc" } }))!.id;

    // One PO we'll receive (→ immutable), one we'll cancel (→ terminal/hidden).
    const toReceive = await createPurchaseOrder(
      ctx.prisma,
      { vendor: "Acme", lines: [{ sku, qty_ordered: 2, unit_cost_cents: 100 }] },
      "po-term-loc",
    );
    const toCancel = await createPurchaseOrder(
      ctx.prisma,
      { vendor: "Acme", lines: [{ sku, qty_ordered: 2, unit_cost_cents: 100 }] },
      "po-term-loc",
    );

    await receivePurchaseOrder(ctx.prisma, toReceive.id, { lines: [{ sku, qty: 2 }], who: "Tester" }, "po-term-loc");

    // Edit/cancel of a received PO throws PoStateConflictError → route 409.
    await expect(
      updatePurchaseOrder(
        ctx.prisma,
        toReceive.id,
        { vendor: "Y", lines: [{ sku, qty_ordered: 1, unit_cost_cents: 100 }] },
        "Tester",
        "po-term-loc",
      ),
    ).rejects.toBeInstanceOf(PoStateConflictError);
    await expect(cancelPurchaseOrder(ctx.prisma, toReceive.id, "Tester", "po-term-loc")).rejects.toBeInstanceOf(
      PoStateConflictError,
    );
    const editReceived = await ctx.app.inject({
      method: "PUT",
      url: `/api/inventory/pos/${toReceive.id}?location=po-term-loc`,
      payload: { vendor: "Y", lines: [{ sku, qty_ordered: 1, unit_cost_cents: 100 }] },
    });
    expect(editReceived.statusCode).toBe(409);
    expect(editReceived.json().error).toBe("po_not_editable");

    // Cancel the open PO: status flips, an activity entry lands, and it's gone
    // from the dataset the API serves.
    const cancelled = await cancelPurchaseOrder(ctx.prisma, toCancel.id, "Maya", "po-term-loc");
    expect(cancelled?.status).toBe("cancelled");
    // Idempotent replay — no throw, no second activity row.
    const replay = await cancelPurchaseOrder(ctx.prisma, toCancel.id, "Maya", "po-term-loc");
    expect(replay?.status).toBe("cancelled");
    expect(
      await ctx.prisma.inventoryActivityEntry.count({
        where: { locationId: "po-term-loc", action: "cancelled", what: { contains: toCancel.id } },
      }),
    ).toBe(1);

    // The row persists (not deleted) but is filtered out of the list the dataset
    // serves — the same `status != cancelled` predicate getDataset applies, so a
    // floor surface never sees it. (Asserted against the table rather than a full
    // GET /api/inventory because later tests in this shared-DB suite seed
    // off-enum categories that would fail the dataset's contract validation.)
    expect(await getPurchaseOrder(ctx.prisma, toCancel.id, "po-term-loc")).not.toBeNull();
    const visiblePos = await ctx.prisma.inventoryPurchaseOrder.findMany({
      where: { locationId: "po-term-loc", status: { not: "cancelled" } },
    });
    expect(visiblePos.map((p) => p.id)).not.toContain(toCancel.id);
  });

  it("a cancelled PO can't be received (defense-in-depth, 409)", async () => {
    const sku = (await ctx.prisma.inventoryItem.findFirst({ orderBy: { id: "asc" } }))!.id;
    const po = await createPurchaseOrder(
      ctx.prisma,
      { vendor: "Acme", lines: [{ sku, qty_ordered: 2, unit_cost_cents: 100 }] },
      "po-cancel-recv",
    );
    await cancelPurchaseOrder(ctx.prisma, po.id, "Maya", "po-cancel-recv");
    await expect(
      receivePurchaseOrder(ctx.prisma, po.id, { lines: [{ sku, qty: 2 }], who: "Tester" }, "po-cancel-recv"),
    ).rejects.toBeInstanceOf(PoStateConflictError);
  });

  it("concurrent waste on one item doesn't lose updates (advisory-lock serialization, audit #1)", async () => {
    const LOC = "stock-race-loc";
    // A dedicated item + location so the seeded catalog and other tests in this
    // shared-DB suite can't perturb the starting on_hand. `createItem` is the
    // suite-local helper (POSTs /api/inventory/items, returns { id }) — NOT the
    // store fn of the same name, which would shadow-collide here.
    const { id: itemId } = await createItem("Race Test Syrup", "food");

    // Known starting on_hand at this location (a count is an absolute set).
    const START = 100;
    await applyCounts(ctx.prisma, { updates: { [itemId]: START }, who: "Seed" }, LOC);

    // Fire N concurrent single-unit wastes with NO idempotency key, so each is a
    // distinct write. Pre-fix these raced on the read-modify-write of on_hand and
    // lost decrements (last absolute write wins); the per-location advisory lock
    // serializes them so every decrement lands.
    const N = 20;
    await Promise.all(
      Array.from({ length: N }, () =>
        recordWaste(
          ctx.prisma,
          { sku: itemId, qty: 1, reason: "spoilage", notes: "", photo: false, cost_cents: 0, who: "Racer" },
          LOC,
        ),
      ),
    );

    const state = await ctx.prisma.inventoryItemState.findUnique({
      where: { locationId_itemId: { locationId: LOC, itemId } },
    });
    // Exactly START - N: no decrement lost.
    expect(state?.onHand).toBe(START - N);

    // And on_hand reconciles with the append-only ledger (+100 count_adjust, -1 × N).
    const agg = await ctx.prisma.inventoryStockMovement.aggregate({
      where: { locationId: LOC, itemId },
      _sum: { delta: true },
    });
    expect(agg._sum.delta).toBe(START - N);
  });

  it("truncateAll wipes table data but leaves the schema intact", async () => {
    await ctx.truncate();
    expect(await ctx.prisma.inventoryItem.count()).toBe(0);
    // A query against the now-empty table still resolves (relation exists),
    // confirming truncate dropped data, not the schema.
    expect(await ctx.prisma.inventoryItemState.findMany()).toEqual([]);
  });
});
