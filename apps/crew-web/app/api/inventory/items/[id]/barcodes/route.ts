import { forwardCrewWrite } from "@/lib/server/inventory-api";

// Floor scan-to-register: map a scanned UPC to an item (+ optional pack), ADR-0737. The crew cookie
// is forwarded so the API's dual-auth accepts the write; inventory-api validates against
// InventoryBarcodeSave. A successful map to a still-pack-less item also fires the P5 "finish setup"
// nudge server-side (a no-op until notifications is wired).
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  return forwardCrewWrite(`/api/inventory/items/${encodeURIComponent(id)}/barcodes`, body);
}
