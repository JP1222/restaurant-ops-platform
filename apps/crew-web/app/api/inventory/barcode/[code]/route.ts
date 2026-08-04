import { proxyInventoryGet } from "@/lib/server/inventory-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Resolve a scanned/typed barcode to { item, pack } (ADR-0737). Open read like the item
// photo proxy — inventory-api isn't browser-reachable, so the floor's lookup comes through
// here. 404 (null body) when the code is unknown; the client surfaces "not found".
export async function GET(_request: Request, context: { params: Promise<{ code: string }> }) {
  const { code } = await context.params;
  return proxyInventoryGet(`/api/inventory/barcode/${encodeURIComponent(code)}`);
}
