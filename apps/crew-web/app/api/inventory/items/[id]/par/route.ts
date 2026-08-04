import { forwardCrewWrite } from "@/lib/server/inventory-api";

// Floor "edit item" low-stock alert → inventory-api par editor
// (PUT /api/inventory/items/:id/par). par is per-LOCATION state, so unlike the
// catalog PUT the API records the acting store; the crew session rides along and
// the API derives both the actor and the location server-side.
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  return forwardCrewWrite(`/api/inventory/items/${encodeURIComponent(id)}/par`, body, "PUT");
}
