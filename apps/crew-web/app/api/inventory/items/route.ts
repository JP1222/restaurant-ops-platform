import { forwardCrewWrite } from "@/lib/server/inventory-api";

// Floor "quick add" → inventory-api catalog create (POST /api/inventory/items).
// A catalog create is not a stock movement, so there's no per-actor `who`; the
// crew session cookie still rides along (forwardCrewWrite) so the API's dual-auth
// accepts the write. inventory-api server-generates the id + sku and validates
// the body against InventoryItemCreateSchema.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  return forwardCrewWrite("/api/inventory/items", body);
}
