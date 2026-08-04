import { forwardCrewWrite } from "@/lib/server/inventory-api";

// Floor "delete item" → inventory-api soft archive (POST /api/inventory/items/:id/archive).
// "Delete" is an archive (archived=true), never a hard delete: items are referenced by
// loose sku/id strings across recipes / POs / waste / movement history with no FK, so a
// hard delete would silently orphan them. The crew session cookie rides along
// (forwardCrewWrite) so the API's dual-auth accepts it and derives the actor server-side.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  return forwardCrewWrite(`/api/inventory/items/${encodeURIComponent(id)}/archive`, body);
}
