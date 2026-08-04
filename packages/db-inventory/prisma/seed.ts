import { InventoryDatasetSchema } from "@rop/contracts";
import { hashPin, pinLookupHash } from "@rop/auth/crew";

import { createPrismaClient } from "../src/index.js";
import { SEED_DATASET } from "./seed-data.js";

const prisma = createPrismaClient();

// Demo floor crew, mirroring apps/crew-web's former hardcoded list so dev data
// matches the prototype. PINs seed the argon2 hash + keyed lookup index; they are
// never persisted or logged in plaintext.
const CREW_PIN_PEPPER = process.env.CREW_PIN_PEPPER ?? "dev-crew-pin-pepper-change-me";

const DEMO_CREW = [
  { id: "EMP-MR", name: "Maya Reyes", role: "Prep Lead", shift: "AM", initials: "MR", color: "#1F8A5B", pin: "123456" },
  { id: "EMP-DL", name: "Diego López", role: "Line Cook", shift: "AM", initials: "DL", color: "#D97757", pin: "258025" },
  { id: "EMP-SK", name: "Samuel Kim", role: "Line Cook", shift: "PM", initials: "SK", color: "#2A6FDB", pin: "777700" },
  { id: "EMP-JH", name: "José Hernández", role: "Dishwasher", shift: "PM", initials: "JH", color: "#7B5BC9", pin: "432109" }
] as const;

async function main() {
  // Validate the demo dataset against the shared contract before touching the
  // database, so seed drift surfaces as a clear zod error rather than a column
  // mismatch deep in an insert.
  // The demo items predate unit conversion: inject sensible defaults (bought one
  // usage-unit at a time, so the derived per-usage cost == the authored cost_cents)
  // before the contract parse. Real items get real conversions via the editor.
  const data = InventoryDatasetSchema.parse({
    ...SEED_DATASET,
    items: SEED_DATASET.items.map((it) => ({
      ...it,
      purchase_unit: "",
      pack_qty: 1,
      purchase_cost_cents: Math.round(it.cost_cents)
    }))
  });

  // Enforce unique PINs — PIN-only login cannot disambiguate a shared PIN.
  if (new Set(DEMO_CREW.map((e) => e.pin)).size !== DEMO_CREW.length) {
    throw new Error("Demo crew PINs must be unique.");
  }
  // Hash outside the transaction so argon2's deliberate slowness doesn't hold it open.
  const crew = await Promise.all(
    DEMO_CREW.map(async (e) => ({
      id: e.id,
      name: e.name,
      role: e.role,
      shift: e.shift,
      initials: e.initials,
      color: e.color,
      pinHash: await hashPin(e.pin),
      pinLookup: pinLookupHash(e.pin, CREW_PIN_PEPPER),
      active: true
    }))
  );

  // PO line detail for the receive flow. Mirror the old crew fake-line logic:
  // prefer items from the PO's vendor, else sample the full pool; `sku` carries
  // the item id (the store keys items by id). Received POs start fully received.
  const poLines = data.pos.flatMap((p) => {
    const matching = data.items.filter((it) => it.vendor === p.vendor);
    const pool = matching.length >= p.lines ? matching : data.items;
    return pool.slice(0, p.lines).map((it) => {
      const qtyOrdered = Math.max(1, Math.round((it.par_max - it.on_hand) * 0.6) || 4);
      return {
        poId: p.id,
        sku: it.id,
        qtyOrdered,
        qtyReceived: p.status === "received" ? qtyOrdered : 0
      };
    });
  });

  await prisma.$transaction(async (tx) => {
    // Wipe child -> parent so a re-seed is idempotent without FK violations.
    await tx.inventoryRecipeLine.deleteMany();
    await tx.inventoryRecipe.deleteMany();
    await tx.inventoryVendorQuote.deleteMany();
    await tx.inventoryWasteEntry.deleteMany();
    await tx.inventoryActivityEntry.deleteMany();
    await tx.inventoryCountRecord.deleteMany();
    await tx.inventoryPoLine.deleteMany();
    await tx.inventoryPurchaseOrder.deleteMany();
    await tx.inventoryVendor.deleteMany();
    await tx.inventoryItemState.deleteMany();
    await tx.inventoryItem.deleteMany();
    await tx.inventoryCategory.deleteMany();
    await tx.inventoryWasteReason.deleteMany();
    await tx.inventoryWasteSettings.deleteMany();
    await tx.inventoryMetrics.deleteMany();
    await tx.inventoryEmployee.deleteMany();

    await tx.inventoryCategory.createMany({ data: data.categories });

    await tx.inventoryItem.createMany({
      data: data.items.map((it) => ({
        id: it.id,
        sku: it.sku,
        name: it.name,
        categoryId: it.category,
        unit: it.unit,
        onHand: it.on_hand,
        parMin: it.par_min,
        parMax: it.par_max,
        costCents: it.cost_cents,
        purchaseUnit: it.purchase_unit,
        packQty: it.pack_qty,
        purchaseCostCents: it.purchase_cost_cents,
        vendor: it.vendor,
        shelfDays: it.shelf_days,
        lastCounted: it.last_counted,
        flagged86: it.flagged_86
      }))
    });

    // Per-location stock state for the default store (Phase 4 part 3). Seeded
    // from the catalog defaults so the default location reads identically to the
    // pre-split single-store dataset.
    await tx.inventoryItemState.createMany({
      data: data.items.map((it) => ({
        locationId: "default-location",
        itemId: it.id,
        onHand: it.on_hand,
        parMin: it.par_min,
        parMax: it.par_max,
        lastCounted: it.last_counted,
        flagged86: it.flagged_86
      }))
    });

    for (const r of data.recipes) {
      await tx.inventoryRecipe.create({
        data: {
          id: r.id,
          name: r.name,
          category: r.category,
          sellCents: r.sell_cents,
          soldToday: r.sold_today,
          lines: { create: r.lines.map((l) => ({ sku: l.sku, qty: l.qty })) }
        }
      });
    }

    await tx.inventoryVendor.createMany({
      data: data.vendors.map((v) => ({
        id: v.id,
        name: v.name,
        type: v.type,
        contact: v.contact,
        phone: v.phone,
        email: v.email,
        account: v.account,
        terms: v.terms,
        minOrderCents: v.min_order_cents,
        cutoff: v.cutoff,
        deliveryDays: v.delivery_days,
        categories: v.categories,
        fillRate: v.fill_rate,
        onTime: v.on_time,
        priceStability: v.price_stability,
        credits90d: v.credits_90d,
        spend30d: v.spend_30d,
        trend4w: v.trend_4w,
        preferred: v.preferred,
        tags: v.tags
      }))
    });

    await tx.inventoryVendorQuote.createMany({
      data: data.vendor_quotes.flatMap((row) =>
        row.quotes.map((q) => ({
          sku: row.sku,
          vendorId: q.vid,
          cents: q.cents,
          primary: q.primary ?? false
        }))
      )
    });

    await tx.inventoryPurchaseOrder.createMany({
      data: data.pos.map((p) => ({
        id: p.id,
        vendor: p.vendor,
        placed: p.placed,
        expected: p.expected,
        lines: p.lines,
        status: p.status,
        totalCents: p.total_cents
      }))
    });

    await tx.inventoryPoLine.createMany({ data: poLines });

    await tx.inventoryCountRecord.createMany({
      data: data.counts.map((c) => ({
        id: c.id,
        date: c.date,
        who: c.who,
        scope: c.scope,
        items: c.items,
        variancePct: c.variance_pct,
        varianceCents: c.variance_cents,
        status: c.status
      }))
    });

    await tx.inventoryWasteReason.createMany({
      data: data.waste_reasons.map((w) => ({
        id: w.id,
        label: w.label,
        color: w.color,
        needsPhotoOverCents: w.needs_photo_over_cents
      }))
    });

    await tx.inventoryWasteEntry.createMany({
      data: data.waste_log.map((w) => ({
        id: w.id,
        at: w.at,
        who: w.who,
        sku: w.sku,
        qty: w.qty,
        reason: w.reason,
        notes: w.notes,
        photo: w.photo,
        approved: w.approved
      }))
    });

    await tx.inventoryActivityEntry.createMany({
      data: data.activity.map((a) => ({
        ...(a.id ? { id: a.id } : {}),
        at: a.at,
        who: a.who,
        action: a.action,
        what: a.what,
        note: a.note
      }))
    });

    await tx.inventoryWasteSettings.create({
      data: {
        id: "singleton",
        photoRequiredOverCents: data.waste_settings.photo_required_over_cents,
        managerApprovalOverCents: data.waste_settings.manager_approval_over_cents
      }
    });

    await tx.inventoryMetrics.create({
      data: {
        id: "singleton",
        cogsTargetPct: data.cogs_target_pct
      }
    });

    await tx.inventoryEmployee.createMany({ data: crew });
  });

  console.log(
    `Seeded inventory: ${data.items.length} items, ${data.recipes.length} recipes, ${data.vendors.length} vendors, ${data.pos.length} POs (${poLines.length} lines), ${crew.length} crew.`
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
