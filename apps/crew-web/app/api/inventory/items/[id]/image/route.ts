import { forwardCrewWrite, proxyInventoryGet } from "@/lib/server/inventory-api";

// Item photo BFF. GET proxies the public image read so an <img> on the floor can
// load it same-origin (inventory-api isn't browser-reachable). PUT forwards a
// base64-encoded photo (InventoryItemImageUpload) carrying the crew session; DELETE
// removes it. Both writes are catalog data, not stock movements — no per-actor `who`.

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return proxyInventoryGet(`/api/inventory/items/${encodeURIComponent(id)}/image`);
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  return forwardCrewWrite(`/api/inventory/items/${encodeURIComponent(id)}/image`, body, "PUT");
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return forwardCrewWrite(`/api/inventory/items/${encodeURIComponent(id)}/image`, null, "DELETE");
}
