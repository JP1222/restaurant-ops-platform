import { forwardCrewWrite } from "@/lib/server/inventory-api";

// Floor "edit item" → inventory-api catalog editor (PUT /api/inventory/items/:id).
// The floor only sends name / category / unit (par is a separate per-location path;
// vendor / cost stay a backoffice manager job, Iron Law #4). A catalog edit is not a
// stock movement, so there's no per-actor `who`; the crew session cookie rides along
// (forwardCrewWrite) so the API's dual-auth accepts the write.
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  return forwardCrewWrite(`/api/inventory/items/${encodeURIComponent(id)}`, body, "PUT");
}
