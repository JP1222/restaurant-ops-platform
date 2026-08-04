import { NextResponse, type NextRequest } from "next/server";
import type { InventoryItemImageUpload } from "@rop/contracts";

import { getSessionUser } from "@/lib/auth/session-user";
import {
  fetchItemImageUpstream,
  handleInventoryApiError,
  inventoryApi
} from "@/lib/inventory-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET proxies the item photo bytes from inventory-api so an <img src> can render it
// same-origin (the browser can't reach inventory-api — Iron Law 4 / rule 11). The
// session proxy already gates this route, so the read needs no extra auth here.
export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ error: "missing_item_id" }, { status: 400 });
  }
  try {
    const upstream = await fetchItemImageUpstream(id);
    if (!upstream.ok) {
      return new NextResponse(null, { status: upstream.status });
    }
    const body = await upstream.arrayBuffer();
    return new NextResponse(body, {
      status: 200,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
        "cache-control": "no-cache"
      }
    });
  } catch (error) {
    return handleInventoryApiError(error, "backoffice.api.inventory.item.image.get");
  }
}

export async function PUT(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ error: "missing_item_id" }, { status: 400 });
  }
  const operator = await getSessionUser(request);
  if (!operator) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  try {
    const body = (await request.json()) as InventoryItemImageUpload;
    await inventoryApi.uploadItemImage(id, body);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleInventoryApiError(error, "backoffice.api.inventory.item.image.put");
  }
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ error: "missing_item_id" }, { status: 400 });
  }
  const operator = await getSessionUser(request);
  if (!operator) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  try {
    await inventoryApi.deleteItemImage(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleInventoryApiError(error, "backoffice.api.inventory.item.image.delete");
  }
}
