import { forwardCrewWrite } from "@/lib/server/inventory-api";

// Floor ad-hoc receive (ADR-0538 D2) → inventory-api POST /api/inventory/receive.
// Used by the invoice-scan confirm step: receive a delivery with no PO, matched
// lines move on_hand and unmatched lines inline-create then receive. `who: "crew"`
// is a placeholder so the contract's required actor passes; inventory-api overrides
// it from the crew session (resolveActor). The crew cookie rides along via
// forwardCrewWrite so the API's dual-auth accepts the write.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  return forwardCrewWrite("/api/inventory/receive", { ...body, who: "crew" });
}
