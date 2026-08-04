import { proxyInventoryGet } from "@/lib/server/inventory-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Scan-to-register enrichment lookup (barcode-onboarding ADR, D3 — opened to the floor). A superset
// of resolve: first matches a registered code, else enriches from the Open Food Facts public API.
// Open read like the resolve proxy (inventory-api isn't browser-reachable). The upstream FAILS OPEN
// — an unknown code / OFF miss / OFF outage all return registered:false with null suggestions — so
// the register form opens blank rather than erroring.
export async function GET(_request: Request, context: { params: Promise<{ upc: string }> }) {
  const { upc } = await context.params;
  return proxyInventoryGet(`/api/inventory/barcode/lookup/${encodeURIComponent(upc)}`);
}
