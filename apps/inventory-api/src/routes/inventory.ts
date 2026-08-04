import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  InventoryAdHocReceiveSchema,
  InventoryCountSubmissionSchema,
  InventoryItemArchiveSchema,
  InventoryItemCreateSchema,
  InventoryItemImageUploadSchema,
  InventoryItemSaveSchema,
  InventoryItemPackSaveSchema,
  InventoryBarcodeSaveSchema,
  InventoryBarcodeResolveSchema,
  InventoryBarcodeEnrichSchema,
  InventoryBarcodeMintRequestSchema,
  InventoryBarcodeMintResponseSchema,
  InventoryParUpdateSchema,
  InventoryPoCancelSchema,
  InventoryPurchaseOrderCreateSchema,
  InventoryPurchaseOrderUpdateSchema,
  InventoryReceiveSubmissionSchema,
  InventoryRecipeCreateSchema,
  InventoryRecipeSaveSchema,
  InventoryToggle86RequestSchema,
  InventoryVendorArchiveSchema,
  InventoryVendorSaveSchema,
  InventoryWasteSubmissionSchema,
  ItemIdSchema,
  PlateCostsResponseSchema,
  PoIdSchema,
  RecipeIdSchema,
  type IngestNotificationRequest,
  type InventoryItem
} from "@rop/contracts";

import type { AppServices } from "../lib/services.js";
import { AnalyticsFeedAuthError, buildAnalyticsSoldItemsFetcher } from "../lib/analytics-client.js";
import { createNotificationsEmitter } from "../lib/notifications-client.js";
import { resolveActor } from "../lib/crew-auth.js";
import * as store from "../lib/inventory-store.js";
import { categoryFromOff, lookupOff, unitFromQuantity } from "../lib/off-lookup.js";
import { computePlateCosts } from "../lib/plate-cost.js";
import * as r2 from "../lib/r2.js";

// The store a request applies to (ADR-0018): the crew actor's location wins
// (server-derived), else the `?location=` query (trusted backoffice BFF), else
// the single-store default.
function locationFor(actor: { locationId: string } | null, request: FastifyRequest): string {
  if (actor) {
    return actor.locationId;
  }
  const raw = (request.query as { location?: unknown } | undefined)?.location;
  return typeof raw === "string" && raw.length > 0 ? raw : store.DEFAULT_LOCATION_ID;
}

// The low-stock notification a producer emits when a stock change takes an item
// from at-or-above its minimum par to below it. Shared by the waste, count, and
// sync-sales routes (Phase 5c); `via` names the trigger ("a waste" / "a recount" /
// "sales depletion"). `who` is optional — an operator action names the actor, the
// system-driven sales depletion omits it.
function lowStockNotification(input: {
  itemName: string;
  itemId: string;
  onHand: number;
  parMin: number;
  via: string;
  who?: string;
}): IngestNotificationRequest {
  const by = input.who ? ` by ${input.who}` : "";
  return {
    severity: "warn",
    category: "inv",
    categoryLabel: "Inventory",
    icon: "trending-down",
    title: `${input.itemName} low on stock`,
    detail: `${input.itemName} fell to ${input.onHand} (par ${input.parMin}) after ${input.via}${by}.`,
    action: { label: "View item", icon: "package", href: `/inventory/items/${input.itemId}` }
  };
}

// The notification a toggle-86 emits. A flip TO 86 (item now unavailable) is a `warn`;
// a flip back to available is an `info` that closes the loop on the 86 alert (the
// manager who saw "X 86'd" now sees "X back in stock"). Phase 5 producer; payload shape
// mirrors lowStockNotification.
function toggle86Notification(
  item: { id: string; name: string; flagged_86: boolean },
  who: string
): IngestNotificationRequest {
  if (item.flagged_86) {
    return {
      severity: "warn",
      category: "inv",
      categoryLabel: "Inventory",
      icon: "ban",
      title: `${item.name} 86'd`,
      detail: `${item.name} was marked unavailable by ${who}.`,
      action: { label: "View item", icon: "package", href: `/inventory/items/${item.id}` }
    };
  }
  return {
    severity: "info",
    category: "inv",
    categoryLabel: "Inventory",
    icon: "circle-check",
    title: `${item.name} back in stock`,
    detail: `${item.name} was marked available again by ${who}.`,
    action: { label: "View item", icon: "package", href: `/inventory/items/${item.id}` }
  };
}

// True when an item has no pack size defined — neither an ADR-0737 InventoryItemPack row nor a
// legacy inline conversion (pack_qty > 1). The scan-to-register flow lets a manager skip the pack
// to keep a haul moving, which leaves receiving-by-the-case + per-unit cost unconfigured.
function lacksPackSize(item: InventoryItem): boolean {
  return (item.packs?.length ?? 0) === 0 && item.pack_qty <= 1;
}

// A gentle "finish setup" nudge emitted after a barcode is registered (or minted) for a pack-less
// item (barcode-onboarding ADR, P5). Reuses the inventory -> notifications producer, like the 86
// and low-stock signals. Brand-global (packs are item-level, not per-location); `dedupeKey` is per
// item so re-scanning the same item never spams the bell. `info` severity — a reminder, not an
// alarm. Note: there is no producer-side "resolve", so adding the pack later doesn't auto-clear it
// — the operator dismisses the nudge once setup is done.
function noPackSizeNudge(item: InventoryItem): IngestNotificationRequest {
  return {
    severity: "info",
    category: "inv",
    categoryLabel: "Inventory",
    icon: "package-plus",
    title: `Finish setup: ${item.name}`,
    detail: `${item.name} was registered without a pack size. Add one so you can receive it by the case.`,
    action: { label: "Add pack size", icon: "package", href: `/inventory/items/${item.id}` },
    dedupeKey: `inv:nopack:${item.id}`
  };
}

export async function registerInventoryRoutes(app: FastifyInstance, services: AppServices) {
  const { prisma, config } = services;
  // Producer emitter → notifications-api ingest (Phase 5). Injected for tests; else
  // built from config (a no-op until INTERNAL_NOTIFICATIONS_API_URL + token are set).
  const notifications =
    services.notifications ??
    createNotificationsEmitter({
      baseUrl: config.notificationsApiUrl,
      token: config.notificationsInternalToken
    });

  // Fire the "finish setup" nudge when a just-barcoded item still has no pack size (P5).
  // Best-effort + fire-and-forget — a notify failure never blocks the barcode write.
  const nudgeIfNoPackSize = (item: InventoryItem, request: FastifyRequest) => {
    if (!lacksPackSize(item)) return;
    void notifications
      .emit(noPackSizeNudge(item))
      .catch((err: unknown) =>
        request.log.error({ err: String(err) }, "notifications ingest failed (no-pack nudge)")
      );
  };

  app.get("/api/inventory", async (request) => {
    const actor = await resolveActor(prisma, request, config);
    // `?include=archived` surfaces soft-deleted items for the archive-management
    // view; the default dataset excludes them (ADR catalog-management D1).
    const includeArchived =
      (request.query as { include?: unknown } | undefined)?.include === "archived";
    return store.getDataset(prisma, locationFor(actor, request), includeArchived);
  });

  // Plate cost per Clover menu item for analytics-api's dim_item_cost ingest
  // (ADR-0031). Cost is brand-level (InventoryItem.costCents) so there is no
  // location scoping. Read-only, like /api/inventory.
  app.get("/api/recipes/plate-costs", async () => {
    const [recipes, items] = await Promise.all([
      prisma.inventoryRecipe.findMany({
        where: { cloverItemId: { not: null } },
        select: { cloverItemId: true, lines: { select: { sku: true, qty: true } } }
      }),
      prisma.inventoryItem.findMany({ select: { sku: true, costCents: true } })
    ]);
    const costBySku = new Map(items.map((item) => [item.sku, item.costCents]));
    const snapshots = computePlateCosts(recipes, costBySku, new Date().toISOString());
    return PlateCostsResponseSchema.parse({ snapshots });
  });

  app.get<{ Params: { id: string } }>("/api/inventory/pos/:id", async (request, reply) => {
    const id = PoIdSchema.safeParse(request.params.id);
    if (!id.success) {
      return reply.code(400).send({ error: "Invalid purchase order id" });
    }
    // Location-scope the read (ADR-0018 Phase 4) like every sibling route: a crew
    // actor is pinned to its own store, so a cook in location B can't read
    // location A's PO by guessing its id (404, not a cross-store leak).
    const actor = await resolveActor(prisma, request, config);
    const po = await store.getPurchaseOrder(prisma, id.data, locationFor(actor, request));
    if (!po) {
      return reply.code(404).send({ error: "Purchase order not found" });
    }
    return po;
  });

  app.post<{ Params: { id: string } }>("/api/inventory/items/:id/toggle-86", async (request, reply) => {
    const id = ItemIdSchema.safeParse(request.params.id);
    if (!id.success) {
      return reply.code(400).send({ error: "Invalid item id" });
    }
    const body = InventoryToggle86RequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "Invalid toggle-86 request", details: body.error.issues });
    }
    const actor = await resolveActor(prisma, request, config);
    const item = await store.toggle86(
      prisma,
      id.data,
      actor?.name ?? "Backoffice",
      locationFor(actor, request)
    );
    if (!item) {
      return reply.code(404).send({ error: "Item not found" });
    }
    // Producer (Phase 5): both the flip TO 86 (warn — item now unavailable) and the
    // flip back to available (info — closes the loop on the 86 alert) emit an operator
    // notification. Best-effort + fire-and-forget — a notify failure never blocks the
    // toggle response.
    void notifications
      .emit(toggle86Notification(item, actor?.name ?? "Backoffice"))
      .catch((err: unknown) =>
        request.log.error({ err: String(err) }, "notifications ingest failed (toggle-86)")
      );
    return { item };
  });

  // Create a catalog item (ADR catalog-management D1, "Add item"). Non-GET write-auth
  // gate applies; a catalog create is not a stock movement, so no per-actor `who`.
  // 409 when a client-supplied sku collides.
  app.post("/api/inventory/items", async (request, reply) => {
    const parsed = InventoryItemCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid item", details: parsed.error.issues });
    }
    const result = await store.createItem(prisma, parsed.data);
    if (!result.ok) {
      return reply.code(409).send({ error: "SKU already in use" });
    }
    return reply.code(201).send({ item: result.item });
  });

  // Catalog item editor (S3): edit name/unit/vendor/shelf-life + the purchase->usage
  // conversion (the API re-derives cost_cents). Non-GET, so the write-auth gate
  // applies; a catalog edit is not a stock movement, so no per-actor `who`.
  app.put<{ Params: { id: string } }>("/api/inventory/items/:id", async (request, reply) => {
    const id = ItemIdSchema.safeParse(request.params.id);
    if (!id.success) {
      return reply.code(400).send({ error: "Invalid item id" });
    }
    const parsed = InventoryItemSaveSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid item", details: parsed.error.issues });
    }
    const item = await store.saveItem(prisma, id.data, parsed.data);
    if (!item) {
      return reply.code(404).send({ error: "Item not found" });
    }
    return { item };
  });

  // Par-level editor (ADR catalog-management D1). par is per-location state, so —
  // unlike the catalog PUT above — this records the acting store. Non-GET write-auth
  // gate applies.
  app.put<{ Params: { id: string } }>("/api/inventory/items/:id/par", async (request, reply) => {
    const id = ItemIdSchema.safeParse(request.params.id);
    if (!id.success) {
      return reply.code(400).send({ error: "Invalid item id" });
    }
    const parsed = InventoryParUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid par update", details: parsed.error.issues });
    }
    const actor = await resolveActor(prisma, request, config);
    const item = await store.updatePar(
      prisma,
      id.data,
      parsed.data,
      actor?.name ?? "Backoffice",
      locationFor(actor, request)
    );
    if (!item) {
      return reply.code(404).send({ error: "Item not found" });
    }
    return { item };
  });

  // Archive / restore an item (ADR catalog-management D1, soft-delete). Never a hard
  // DELETE — archived items are retained so recipe/PO/waste/movement references stay
  // intact. Non-GET write-auth gate applies.
  app.post<{ Params: { id: string } }>("/api/inventory/items/:id/archive", async (request, reply) => {
    const id = ItemIdSchema.safeParse(request.params.id);
    if (!id.success) {
      return reply.code(400).send({ error: "Invalid item id" });
    }
    const parsed = InventoryItemArchiveSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid archive request", details: parsed.error.issues });
    }
    const actor = await resolveActor(prisma, request, config);
    const item = await store.setArchived(
      prisma,
      id.data,
      parsed.data.archived,
      actor?.name ?? "Backoffice",
      locationFor(actor, request)
    );
    if (!item) {
      return reply.code(404).send({ error: "Item not found" });
    }
    return { item };
  });

  // Floor-auth security settings — open read. inventory-api is internal-only, so
  // this is reachable only by crew-web (which enforces the crew IP allowlist at the
  // edge) and the backoffice BFF, never the public internet. crew-web polls it on
  // login; the value (a list of allowed IPs) isn't sensitive.
  app.get("/api/inventory/security-settings", async () => {
    return store.getSecuritySettings(prisma);
  });

  // Item photo (floor "edit item" / backoffice). The GET is an open read like the
  // dataset (no auth gate — a photo is not sensitive), so the browser can render it
  // straight from an <img>. Cache-busting is the caller's job (a `?v=` query); we
  // send no-cache so a re-upload shows immediately even on a stale URL.
  app.get<{ Params: { id: string } }>("/api/inventory/items/:id/image", async (request, reply) => {
    const id = ItemIdSchema.safeParse(request.params.id);
    if (!id.success) {
      return reply.code(400).send({ error: "Invalid item id" });
    }
    const image = await store.getItemImage(prisma, id.data);
    if (!image) {
      return reply.code(404).send({ error: "No image" });
    }
    return reply
      .header("content-type", image.contentType)
      .header("cache-control", "no-cache")
      .send(image.data);
  });

  // Upload / replace an item photo. The browser resizes client-side and posts the
  // image base64-encoded (InventoryItemImageUpload); we decode and store the bytes
  // in Postgres. Non-GET, so the write-auth gate applies; a photo is catalog data,
  // not a stock movement, so no per-actor `who`. The decoded size is bounded again
  // here (the base64 length cap in the schema is the first gate).
  const MAX_IMAGE_BYTES = 2_000_000;
  // The base64 image body is larger than Fastify's 1MB default, so raise the
  // limit for THIS route only (a ~2MB photo ≈ ~2.8MB base64 + JSON envelope).
  // Every other inventory route keeps the small default — an oversized body on
  // them is still rejected up front.
  const IMAGE_BODY_LIMIT = 4_000_000;
  app.put<{ Params: { id: string } }>(
    "/api/inventory/items/:id/image",
    { bodyLimit: IMAGE_BODY_LIMIT },
    async (request, reply) => {
      const id = ItemIdSchema.safeParse(request.params.id);
      if (!id.success) {
        return reply.code(400).send({ error: "Invalid item id" });
      }
      const parsed = InventoryItemImageUploadSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid image", details: parsed.error.issues });
      }
      const data = Buffer.from(parsed.data.data_base64, "base64");
      if (data.length === 0 || data.length > MAX_IMAGE_BYTES) {
        return reply.code(400).send({ error: "Image too large or empty" });
      }
      const ok = await store.setItemImage(prisma, id.data, parsed.data.content_type, data);
      if (!ok) {
        return reply.code(404).send({ error: "Item not found" });
      }
      return reply.code(204).send();
    }
  );

  app.delete<{ Params: { id: string } }>(
    "/api/inventory/items/:id/image",
    async (request, reply) => {
      const id = ItemIdSchema.safeParse(request.params.id);
      if (!id.success) {
        return reply.code(400).send({ error: "Invalid item id" });
      }
      const ok = await store.deleteItemImage(prisma, id.data);
      if (!ok) {
        return reply.code(404).send({ error: "Item not found" });
      }
      return reply.code(204).send();
    }
  );

  // Vendor management (ADR catalog-management D2). Create / edit / archive against the
  // existing InventoryVendor entity. Non-GET write-auth gate applies; no per-actor `who`
  // (catalog management, not a stock movement). item.vendor / po.vendor stay name
  // strings (D2 keeps the linkage denormalized — no FK migration).
  app.post("/api/inventory/vendors", async (request, reply) => {
    const parsed = InventoryVendorSaveSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid vendor", details: parsed.error.issues });
    }
    const vendor = await store.createVendor(prisma, parsed.data);
    return reply.code(201).send({ vendor });
  });

  app.put<{ Params: { id: string } }>("/api/inventory/vendors/:id", async (request, reply) => {
    const parsed = InventoryVendorSaveSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid vendor", details: parsed.error.issues });
    }
    const vendor = await store.updateVendor(prisma, request.params.id, parsed.data);
    if (!vendor) {
      return reply.code(404).send({ error: "Vendor not found" });
    }
    return { vendor };
  });

  app.post<{ Params: { id: string } }>("/api/inventory/vendors/:id/archive", async (request, reply) => {
    const parsed = InventoryVendorArchiveSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid archive request", details: parsed.error.issues });
    }
    const vendor = await store.setVendorArchived(prisma, request.params.id, parsed.data.archived);
    if (!vendor) {
      return reply.code(404).send({ error: "Vendor not found" });
    }
    return { vendor };
  });

  // Packs (ADR-0737): manager catalog editor defines an item's packaging conversions. Writes,
  // so the dual-auth gate applies. Each returns the fresh { item } (with packs/barcodes); 404
  // when the item is gone; 409 on a duplicate (vendor, label); 400/404 on an unknown pack id.
  app.post<{ Params: { id: string } }>("/api/inventory/items/:id/packs", async (request, reply) => {
    const id = ItemIdSchema.safeParse(request.params.id);
    if (!id.success) {
      return reply.code(400).send({ error: "Invalid item id" });
    }
    const parsed = InventoryItemPackSaveSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid pack", details: parsed.error.issues });
    }
    try {
      const item = await store.savePack(prisma, id.data, parsed.data);
      if (!item) {
        return reply.code(404).send({ error: "Item not found" });
      }
      return reply.code(201).send({ item });
    } catch (error) {
      if (error instanceof store.PackLabelConflictError) {
        return reply.code(409).send({ error: "pack_exists", label: error.label });
      }
      throw error;
    }
  });

  app.put<{ Params: { id: string; packId: string } }>(
    "/api/inventory/items/:id/packs/:packId",
    async (request, reply) => {
      const id = ItemIdSchema.safeParse(request.params.id);
      const packId = ItemIdSchema.safeParse(request.params.packId);
      if (!id.success || !packId.success) {
        return reply.code(400).send({ error: "Invalid id" });
      }
      const parsed = InventoryItemPackSaveSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid pack", details: parsed.error.issues });
      }
      try {
        const item = await store.savePack(prisma, id.data, parsed.data, packId.data);
        if (!item) {
          return reply.code(404).send({ error: "Item not found" });
        }
        return { item };
      } catch (error) {
        if (error instanceof store.PackNotFoundError) {
          return reply.code(404).send({ error: "pack_not_found", pack_id: error.packId });
        }
        if (error instanceof store.PackLabelConflictError) {
          return reply.code(409).send({ error: "pack_exists", label: error.label });
        }
        throw error;
      }
    }
  );

  app.delete<{ Params: { id: string; packId: string } }>(
    "/api/inventory/items/:id/packs/:packId",
    async (request, reply) => {
      const id = ItemIdSchema.safeParse(request.params.id);
      const packId = ItemIdSchema.safeParse(request.params.packId);
      if (!id.success || !packId.success) {
        return reply.code(400).send({ error: "Invalid id" });
      }
      const item = await store.deletePack(prisma, id.data, packId.data);
      if (!item) {
        return reply.code(404).send({ error: "Item not found" });
      }
      return { item };
    }
  );

  // Barcodes (ADR-0737): map a scanned/printed code to the item (+ optional pack). Writes,
  // gated. 400 unknown_pack when pack_id doesn't belong to the item.
  app.post<{ Params: { id: string } }>("/api/inventory/items/:id/barcodes", async (request, reply) => {
    const id = ItemIdSchema.safeParse(request.params.id);
    if (!id.success) {
      return reply.code(400).send({ error: "Invalid item id" });
    }
    const parsed = InventoryBarcodeSaveSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid barcode", details: parsed.error.issues });
    }
    try {
      const item = await store.saveBarcode(prisma, id.data, parsed.data);
      if (!item) {
        return reply.code(404).send({ error: "Item not found" });
      }
      nudgeIfNoPackSize(item, request);
      return reply.code(201).send({ item });
    } catch (error) {
      if (error instanceof store.PackNotFoundError) {
        return reply.code(400).send({ error: "unknown_pack", pack_id: error.packId });
      }
      throw error;
    }
  });

  // Mint a house code for a no-UPC item (barcode-onboarding ADR, D4): the floor prints + scans
  // a `YR-#####` Code128 label for cups/straws/supplies. Server-generated + idempotent per
  // (item, pack). Write-auth gated by the global non-GET preHandler.
  app.post<{ Params: { id: string } }>("/api/inventory/items/:id/barcodes/mint", async (request, reply) => {
    const id = ItemIdSchema.safeParse(request.params.id);
    if (!id.success) {
      return reply.code(400).send({ error: "Invalid item id" });
    }
    const parsed = InventoryBarcodeMintRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid mint request", details: parsed.error.issues });
    }
    try {
      const result = await store.mintBarcode(prisma, id.data, parsed.data.pack_id);
      if (!result) {
        return reply.code(404).send({ error: "Item not found" });
      }
      nudgeIfNoPackSize(result.item, request);
      return reply.code(201).send(InventoryBarcodeMintResponseSchema.parse(result));
    } catch (error) {
      if (error instanceof store.PackNotFoundError) {
        return reply.code(400).send({ error: "unknown_pack", pack_id: error.packId });
      }
      throw error;
    }
  });

  app.delete<{ Params: { id: string; code: string } }>(
    "/api/inventory/items/:id/barcodes/:code",
    async (request, reply) => {
      const id = ItemIdSchema.safeParse(request.params.id);
      const code = ItemIdSchema.safeParse(request.params.code);
      if (!id.success || !code.success) {
        return reply.code(400).send({ error: "Invalid id" });
      }
      const item = await store.deleteBarcode(prisma, id.data, code.data);
      if (!item) {
        return reply.code(404).send({ error: "Item not found" });
      }
      return { item };
    }
  );

  // Resolve a scanned barcode to { item, pack } (ADR-0737). Open read like the dataset GET;
  // the floor scans this for receive/count. 404 when the code is unknown.
  app.get<{ Params: { code: string } }>("/api/inventory/barcode/:code", async (request, reply) => {
    const code = ItemIdSchema.safeParse(request.params.code);
    if (!code.success) {
      return reply.code(400).send({ error: "Invalid barcode" });
    }
    const result = await store.resolveBarcode(prisma, code.data);
    if (!result) {
      return reply.code(404).send({ error: "Barcode not found" });
    }
    return InventoryBarcodeResolveSchema.parse(result);
  });

  // Scan-to-register lookup (barcode-onboarding ADR, D3). A superset of resolve for the backoffice
  // scan flow: first resolve against registered barcodes, else enrich from the Open Food Facts
  // public API. Open read like resolve (the internal-only BFF is the caller). FAILS OPEN — an
  // unknown code, an OFF miss, or an OFF outage all return registered:false with null suggestions,
  // so the review form opens blank rather than erroring.
  app.get<{ Params: { upc: string } }>("/api/inventory/barcode/lookup/:upc", async (request, reply) => {
    const upc = ItemIdSchema.safeParse(request.params.upc);
    if (!upc.success) {
      return reply.code(400).send({ error: "Invalid barcode" });
    }
    const resolved = await store.resolveBarcode(prisma, upc.data);
    if (resolved) {
      return InventoryBarcodeEnrichSchema.parse({
        registered: true,
        item: resolved.item,
        pack: resolved.pack,
        off: null,
        suggestions: null
      });
    }
    const hit = await lookupOff(upc.data, config.offApiBaseUrl);
    if (!hit) {
      return InventoryBarcodeEnrichSchema.parse({
        registered: false,
        item: null,
        pack: null,
        off: null,
        suggestions: null
      });
    }
    const unit = unitFromQuantity(hit.quantity);
    return InventoryBarcodeEnrichSchema.parse({
      registered: false,
      item: null,
      pack: null,
      off: { product_name: hit.product_name, brands: hit.brands, quantity: hit.quantity },
      suggestions: {
        name: hit.product_name,
        category: categoryFromOff(hit.categories_en),
        unit: unit?.unit ?? "each",
        unit_kind: unit?.unit_kind ?? "count"
      }
    });
  });

  app.post("/api/inventory/counts", async (request, reply) => {
    const parsed = InventoryCountSubmissionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid count submission", details: parsed.error.issues });
    }
    const actor = await resolveActor(prisma, request, config);
    const result = await store.applyCounts(
      prisma,
      actor ? { ...parsed.data, who: actor.name } : parsed.data,
      locationFor(actor, request)
    );
    // Producer (Phase 5c): emit a low-stock alert for each item this recount took
    // below its minimum par — best-effort + fire-and-forget. `lowStock` is an
    // internal signal; it is stripped from the response below.
    const who = actor?.name ?? "Backoffice";
    for (const crossing of result.lowStock ?? []) {
      void notifications
        .emit(lowStockNotification({ ...crossing, via: "a recount", who }))
        .catch((err: unknown) =>
          request.log.error({ err: String(err) }, "notifications ingest failed (low-stock)")
        );
    }
    return { count: result.count, items_updated: result.items_updated };
  });

  app.post("/api/inventory/waste", async (request, reply) => {
    const parsed = InventoryWasteSubmissionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid waste submission", details: parsed.error.issues });
    }
    const actor = await resolveActor(prisma, request, config);
    try {
      const result = await store.recordWaste(
        prisma,
        actor ? { ...parsed.data, who: actor.name } : parsed.data,
        locationFor(actor, request)
      );
      // Producer (Phase 5c): a waste that took the item below its minimum par is a
      // low-stock alert — best-effort + fire-and-forget, like toggle-86. `lowStock`
      // is an internal signal; it is stripped from the response below.
      const { lowStock, item } = result;
      if (lowStock && item) {
        const who = actor?.name ?? "Backoffice";
        void notifications
          .emit(
            lowStockNotification({
              itemName: item.name,
              itemId: item.id,
              onHand: item.on_hand,
              parMin: lowStock.parMin,
              via: "a waste",
              who
            })
          )
          .catch((err: unknown) =>
            request.log.error({ err: String(err) }, "notifications ingest failed (low-stock)")
          );
      }
      return { entry: result.entry, item };
    } catch (error) {
      if (error instanceof store.PackNotFoundError) {
        return reply.code(400).send({ error: "unknown_pack", pack_id: error.packId });
      }
      throw error;
    }
  });

  // Create a purchase order (ADR catalog-management D3, "New PO"). Non-GET write-auth
  // gate applies. Location-scoped from the actor / ?location like the receive flow.
  app.post("/api/inventory/pos", async (request, reply) => {
    const parsed = InventoryPurchaseOrderCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "Invalid purchase order", details: parsed.error.issues });
    }
    const actor = await resolveActor(prisma, request, config);
    try {
      const po = await store.createPurchaseOrder(prisma, parsed.data, locationFor(actor, request));
      return reply.code(201).send({ po });
    } catch (error) {
      // A line referenced a sku that isn't in the catalog (2026-06-16 audit #6).
      if (error instanceof store.UnknownItemsError) {
        return reply.code(400).send({ error: "unknown_skus", skus: error.skus });
      }
      throw error;
    }
  });

  // Edit an open PO (2026-06-12 audit P1). Full replace of vendor/expected/lines.
  // 404 when the id doesn't exist for this location; 409 `po_not_editable` when the
  // PO is received (immutable) or cancelled (terminal). Non-GET write-auth gate.
  app.put<{ Params: { id: string } }>("/api/inventory/pos/:id", async (request, reply) => {
    const id = PoIdSchema.safeParse(request.params.id);
    if (!id.success) {
      return reply.code(400).send({ error: "Invalid purchase order id" });
    }
    const parsed = InventoryPurchaseOrderUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "Invalid purchase order", details: parsed.error.issues });
    }
    const actor = await resolveActor(prisma, request, config);
    // Attribution: the crew actor (server-derived) wins; else the trusted BFF's
    // supplied operator name; else a generic label. Never trust a client `who`
    // on the crew path.
    const who = actor?.name ?? parsed.data.who ?? "Backoffice";
    try {
      const po = await store.updatePurchaseOrder(
        prisma,
        id.data,
        parsed.data,
        who,
        locationFor(actor, request)
      );
      if (!po) {
        return reply.code(404).send({ error: "Purchase order not found" });
      }
      return { po };
    } catch (error) {
      if (error instanceof store.PoStateConflictError) {
        return reply.code(409).send({ error: "po_not_editable", status: error.status });
      }
      if (error instanceof store.UnknownItemsError) {
        return reply.code(400).send({ error: "unknown_skus", skus: error.skus });
      }
      throw error;
    }
  });

  // Cancel an open PO (2026-06-12 audit P1). Idempotent; 404 when missing, 409
  // `po_not_editable` when already received (the stock moved — that's a count
  // correction, not a cancellation). Non-GET write-auth gate.
  app.post<{ Params: { id: string } }>("/api/inventory/pos/:id/cancel", async (request, reply) => {
    const id = PoIdSchema.safeParse(request.params.id);
    if (!id.success) {
      return reply.code(400).send({ error: "Invalid purchase order id" });
    }
    // Body is optional; it carries only the operator attribution (the BFF sends
    // it). A missing/empty body is fine — cancel from the floor has no body.
    const parsed = InventoryPoCancelSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid cancel request", details: parsed.error.issues });
    }
    const actor = await resolveActor(prisma, request, config);
    const who = actor?.name ?? parsed.data.who ?? "Backoffice";
    try {
      const po = await store.cancelPurchaseOrder(
        prisma,
        id.data,
        who,
        locationFor(actor, request)
      );
      if (!po) {
        return reply.code(404).send({ error: "Purchase order not found" });
      }
      return { po };
    } catch (error) {
      if (error instanceof store.PoStateConflictError) {
        return reply.code(409).send({ error: "po_not_editable", status: error.status });
      }
      throw error;
    }
  });

  app.post<{ Params: { id: string } }>("/api/inventory/pos/:id/receive", async (request, reply) => {
    const id = PoIdSchema.safeParse(request.params.id);
    if (!id.success) {
      return reply.code(400).send({ error: "Invalid purchase order id" });
    }
    const parsed = InventoryReceiveSubmissionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid receive submission", details: parsed.error.issues });
    }
    const actor = await resolveActor(prisma, request, config);
    try {
      const po = await store.receivePurchaseOrder(
        prisma,
        id.data,
        actor ? { ...parsed.data, who: actor.name } : parsed.data,
        locationFor(actor, request)
      );
      if (!po) {
        return reply.code(404).send({ error: "Purchase order not found" });
      }
      return { po };
    } catch (error) {
      // A cancelled PO can't be received (defense-in-depth — the floor never
      // sees cancelled POs since they're excluded from the dataset).
      if (error instanceof store.PoStateConflictError) {
        return reply.code(409).send({ error: "po_not_editable", status: error.status });
      }
      // A receive line named a pack that doesn't belong to its item (ADR-0737).
      if (error instanceof store.PackNotFoundError) {
        return reply.code(400).send({ error: "unknown_pack", pack_id: error.packId });
      }
      throw error;
    }
  });

  // Ad-hoc receive (ADR invoice-scan D2): receive a delivery with NO purchase order.
  // Non-GET, so the app-level write-auth gate applies; `who` is server-derived from
  // the actor like waste/count. Lines either target an existing item by sku or carry
  // name+category+unit to inline-create one. Returns { received, created } counts.
  //
  // May carry an optional base64 receipt image to ARCHIVE (receipt-archive). That makes
  // the body larger than Fastify's 1MB default (an ~8MB-base64 image + the lines
  // envelope), so raise the limit for THIS route only — every other write keeps the
  // small default. The image upload is best-effort and happens OUTSIDE the DB
  // transaction (see below).
  const RECEIPT_BODY_LIMIT = 12_000_000;
  app.post(
    "/api/inventory/receive",
    { bodyLimit: RECEIPT_BODY_LIMIT },
    async (request, reply) => {
      const parsed = InventoryAdHocReceiveSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "Invalid receive submission", details: parsed.error.issues });
      }
      const actor = await resolveActor(prisma, request, config);
      // Strip the (large) image off the submission the store sees — it persists only
      // the R2 key, never the bytes, and we don't want 8MB riding through the DB tx.
      const { receipt_image_base64, receipt_content_type, ...rest } = parsed.data;
      const submission = actor ? { ...rest, who: actor.name } : rest;
      const locationId = locationFor(actor, request);

      // Best-effort receipt-image archive (receipt-archive). Upload the bytes to object
      // storage HERE (network I/O, outside the DB transaction), then hand receiveAdHoc
      // the resulting key + the shared idempotency ref so it records the archive row
      // inside its own transaction. The R2 key derives from ref, so a retried receive
      // overwrites the same object instead of leaking a duplicate.
      let archive: store.ReceiveArchive | undefined;
      if (receipt_image_base64 && receipt_content_type) {
        const ref = submission.idempotency_key ?? randomUUID();
        const data = Buffer.from(receipt_image_base64, "base64");
        const key = r2.receiptImageKey(locationId, ref, receipt_content_type);

        // --- Option A: best-effort archive (your call — review/tweak freely) -------------
        // A failed image upload must NOT fail the receive. Two non-fatal outcomes leave
        // imageKey null: R2 unconfigured (putReceiptImage -> false, expected on dev, just
        // info) and a real upload error (throw -> warn so it's visible in logs/Sentry).
        // `archive` is set either way, so the log row is always written.
        let imageKey: string | null = null;
        try {
          const stored = await r2.putReceiptImage(config, key, data, receipt_content_type);
          if (stored) {
            imageKey = key;
          } else {
            request.log.info({ key }, "receipt-archive: R2 unconfigured, receiving without image");
          }
        } catch (err) {
          request.log.warn({ err, key }, "receipt-archive: image upload failed, receiving without it");
        }
        archive = { ref, imageKey, contentType: receipt_content_type };
      }

      let result: store.AdHocReceiveResult;
      try {
        result = await store.receiveAdHoc(prisma, submission, locationId, archive);
      } catch (error) {
        // A line named a pack that doesn't belong to its item (ADR-0737).
        if (error instanceof store.PackNotFoundError) {
          return reply.code(400).send({ error: "unknown_pack", pack_id: error.packId });
        }
        throw error;
      }
      return reply.code(201).send(result);
    }
  );

  // Archived receipt scans for the backoffice Receiving "history" view (receipt-archive),
  // newest first. Optional ?from / ?to are opaque "YYYY-MM-DD" day bounds (inclusive).
  // Open read like the dataset GET (inventory-api is internal; the BFF gates access);
  // carries only metadata + the line snapshot + has_image, never the bytes. { receipts }.
  app.get("/api/inventory/receipts", async (request) => {
    const actor = await resolveActor(prisma, request, config);
    const query = request.query as { from?: unknown; to?: unknown } | undefined;
    // Build opts without explicit undefined (exactOptionalPropertyTypes): omit an
    // absent bound entirely so the store treats it as open-ended.
    const opts: { from?: string; to?: string } = {};
    if (typeof query?.from === "string") {
      opts.from = query.from;
    }
    if (typeof query?.to === "string") {
      opts.to = query.to;
    }
    const receipts = await store.listReceiptScans(prisma, locationFor(actor, request), opts);
    return { receipts };
  });

  // Serve one archived receipt image straight from object storage, like the item-photo
  // GET (open read; the BFF gates it; immutable so it may cache). 404 when the scan is
  // unknown, belongs to another location, was logged without a stored image (best-effort
  // archive miss), or the R2 object is gone.
  app.get<{ Params: { id: string } }>(
    "/api/inventory/receipts/:id/image",
    async (request, reply) => {
      const actor = await resolveActor(prisma, request, config);
      const stored = await store.getReceiptScanImage(
        prisma,
        request.params.id,
        locationFor(actor, request)
      );
      if (!stored) {
        return reply.code(404).send({ error: "No image" });
      }
      const image = await r2.getReceiptImage(config, stored.imageKey);
      if (!image) {
        return reply.code(404).send({ error: "No image" });
      }
      return reply
        .header("content-type", image.contentType)
        .header("cache-control", "private, max-age=3600")
        .send(image.data);
    }
  );

  // Create a new recipe (menu item) header — name/category/sell, empty BOM. Non-GET,
  // so the app-level write-auth gate applies; the BOM is filled in afterward via the
  // editor's PUT. Mirrors POST /items (catalog create, no per-actor `who`).
  app.post("/api/inventory/recipes", async (request, reply) => {
    const parsed = InventoryRecipeCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid recipe", details: parsed.error.issues });
    }
    const recipe = await store.createRecipe(prisma, parsed.data);
    return reply.code(201).send(recipe);
  });

  // Recipe editor (ADR-0028). GET is an open read (like the dataset); PUT is a
  // catalog write, so the app-level preHandler gate (non-GET under /api/inventory)
  // already requires the crew session or internal bearer. A recipe edit is not a
  // stock movement, so no per-actor `who` is recorded.
  app.get<{ Params: { id: string } }>("/api/inventory/recipes/:id", async (request, reply) => {
    const id = RecipeIdSchema.safeParse(request.params.id);
    if (!id.success) {
      return reply.code(400).send({ error: "Invalid recipe id" });
    }
    const recipe = await store.getRecipeDetail(prisma, id.data);
    if (!recipe) {
      return reply.code(404).send({ error: "Recipe not found" });
    }
    return recipe;
  });

  app.put<{ Params: { id: string } }>("/api/inventory/recipes/:id", async (request, reply) => {
    const id = RecipeIdSchema.safeParse(request.params.id);
    if (!id.success) {
      return reply.code(400).send({ error: "Invalid recipe id" });
    }
    const parsed = InventoryRecipeSaveSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid recipe", details: parsed.error.issues });
    }
    const recipe = await store.saveRecipe(prisma, id.data, parsed.data);
    if (!recipe) {
      return reply.code(404).send({ error: "Recipe not found" });
    }
    return recipe;
  });

  // Manual "Sync sales" trigger (ADR-0028 / S4b): pull sold line items from
  // analytics-api's read-only feed and deplete their BOMs once. Idempotent per
  // Clover line item, so it's safe to click repeatedly. Non-GET, so the app-level
  // write-auth gate (crew session or internal bearer) already applies. Returns the
  // poll result (InventoryDepletionRunResult): applied / skipped / unmatched / cursor.
  app.post("/api/inventory/sync-sales", async (request, reply) => {
    if (!config.analyticsApiUrl || !config.analyticsAdminToken || !config.cloverMerchantId) {
      return reply.code(503).send({
        error:
          "Sales feed not configured (needs INTERNAL_ANALYTICS_API_URL, ANALYTICS_ADMIN_TOKEN, CLOVER_MERCHANT_ID)"
      });
    }
    const actor = await resolveActor(prisma, request, config);
    const fetchSoldItems = buildAnalyticsSoldItemsFetcher({
      baseUrl: config.analyticsApiUrl,
      token: config.analyticsAdminToken,
      merchantId: config.cloverMerchantId
    });
    try {
      const poll = await store.runDepletionPoll(prisma, fetchSoldItems, locationFor(actor, request));
      // Producer (Phase 5c): emit a low-stock alert for each item these sales took
      // below its minimum par — best-effort + fire-and-forget, like the waste/count
      // routes. The crossing is a system-driven (not operator) signal, so the alert
      // omits a `who`; `lowStock` is internal and never returned to the caller.
      for (const crossing of poll.lowStock ?? []) {
        void notifications
          .emit(lowStockNotification({ ...crossing, via: "sales depletion" }))
          .catch((err: unknown) =>
            request.log.error({ err: String(err) }, "notifications ingest failed (low-stock)")
          );
      }
      return { applied: poll.applied, skipped: poll.skipped, unmatched: poll.unmatched, cursor: poll.cursor };
    } catch (err) {
      // GH #468: a rejected ANALYTICS_ADMIN_TOKEN otherwise fell through to the
      // global handler as an opaque 500. Surface it as a clear, actionable 502 so
      // the operator knows to check the token (not customer data — safe to show).
      if (err instanceof AnalyticsFeedAuthError) {
        request.log.error({ status: err.status }, "sync-sales: analytics feed rejected the token");
        return reply.code(502).send({
          error: "Sales feed auth rejected by analytics-api — check ANALYTICS_ADMIN_TOKEN."
        });
      }
      throw err;
    }
  });
}
