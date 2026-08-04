import { forwardCrewWrite } from "@/lib/server/inventory-api";

// Floor scan-to-register: create a packaging conversion (ADR-0737) on a just-created item so a
// scanned case UPC maps to "1 Caja = N base units". The crew cookie rides along (forwardCrewWrite)
// so the API's dual-auth accepts the write; inventory-api validates against InventoryItemPackSave.
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  return forwardCrewWrite(`/api/inventory/items/${encodeURIComponent(id)}/packs`, body);
}
