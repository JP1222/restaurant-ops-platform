import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { InventoryReceiptParseResultSchema, type InventoryDataset } from "@rop/contracts";

import { CREW_COOKIE, inventoryApiUrl } from "@/lib/server/inventory-api";

export const dynamic = "force-dynamic";

// Crew invoice-scan extraction (design handoff §3, ADR-0538). Returns RAW line
// descriptions only, never catalog SKUs — description→item matching is the client's
// deterministic job (lib/scan.ts), so a hallucinated SKU can't reach the ledger.
//
// Two paths:
//   - REAL: the vision provider (Google Gemini — DeepSeek has no image API, #583) + key
//     live only in backoffice (ADR-0538 D3), and crew-web has no AI provider, so a
//     configured store forwards the image to backoffice's /api/inventory/receipt-parse
//     server-to-server with a shared INTERNAL_AI_TOKEN. Gated on INTERNAL_AI_TOKEN +
//     INTERNAL_BACKOFFICE_URL.
//   - STUB (dev fallback): when unconfigured, sample the LIVE catalog and synthesize
//     believable lines (one price-bumped for the change chip + one unrecognized for
//     the new-SKU path) so `make dev` demos without an AI key. In PRODUCTION an
//     unconfigured scan fails closed (503) instead — a cook must never import lines
//     the demo stub invented as if they were a real receipt.
const QTYS = [24, 8, 12, 6, 4];

// Proxy deadline for the backoffice vision call. Sits just ABOVE backoffice's own 90s
// VISION_TIMEOUT_MS so a legitimately slow parse still surfaces as backoffice's own 504
// (retryable) rather than being cut off here; but a genuinely hung connection now fails
// at 95s instead of pinning the cook's scan until the OS-level TCP timeout (minutes).
// The route had no timeout before — a stuck backend froze the Analizando… screen.
const PROXY_TIMEOUT_MS = 95_000;

export async function POST(request: Request): Promise<Response> {
  // A scan is a crew action: require the session cookie (a missing/expired cookie
  // 401s → the SPA bounces to PIN login).
  const token = (await cookies()).get(CREW_COOKIE)?.value;
  if (!token) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Real path — proxy the captured image to backoffice's Gemini vision parse.
  const aiToken = process.env.INTERNAL_AI_TOKEN;
  const backofficeUrl = process.env.INTERNAL_BACKOFFICE_URL;
  if (aiToken && backofficeUrl) {
    let body: { image_base64?: unknown; mime_type?: unknown };
    try {
      body = (await request.json()) as { image_base64?: unknown; mime_type?: unknown };
    } catch {
      body = {};
    }
    try {
      const upstream = await fetch(`${backofficeUrl}/api/inventory/receipt-parse`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${aiToken}` },
        body: JSON.stringify({ image_base64: body.image_base64, mime_type: body.mime_type }),
        signal: AbortSignal.timeout(PROXY_TIMEOUT_MS)
      });
      // Pass the parse (or backoffice's error status: 503 unkeyed / 429 rate-limited
      // / 4xx invalid) straight through; the client surfaces it.
      const text = await upstream.text();
      return new NextResponse(text, {
        status: upstream.status,
        headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" }
      });
    } catch (err) {
      // AbortSignal.timeout aborts with a DOMException named "TimeoutError" that is NOT
      // `instanceof Error` in Node, so match on the name. Surface it as 504 (the client
      // maps 504 → the retryable "timeout" failure → "Tardó demasiado. Intenta de nuevo.")
      // rather than the generic 502 "unavailable", so a slow-but-recoverable parse reads
      // as "try again", not "service down".
      if ((err as { name?: string } | null)?.name === "TimeoutError") {
        return NextResponse.json({ error: "vision_timeout" }, { status: 504 });
      }
      return NextResponse.json({ error: "ai unavailable" }, { status: 502 });
    }
  }

  // Unconfigured: fail closed in production, stub in dev (see header).
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "scan_not_configured" }, { status: 503 });
  }

  // Loud dev-only signal: the stub returns SYNTHESIZED lines, not a real scan. Silent
  // stub output — when INTERNAL_AI_TOKEN/INTERNAL_BACKOFFICE_URL aren't wired (e.g. the
  // default `local` secrets backend instead of SECRETS_BACKEND=infisical) — is a footgun:
  // it looks exactly like a real Gemini extraction. Pair with the `X-Scan-Source: stub`
  // header on the response below so it's also detectable without watching the logs.
  console.warn(
    "[crew-scan] STUB DATA — no INTERNAL_AI_TOKEN/INTERNAL_BACKOFFICE_URL configured; " +
      "returning synthesized invoice lines, NOT a real scan. Use SECRETS_BACKEND=infisical for the real Gemini path.",
  );

  let dataset: InventoryDataset;
  try {
    const res = await fetch(inventoryApiUrl("/api/inventory"), { cache: "no-store" });
    if (!res.ok) throw new Error("inventory unavailable");
    dataset = (await res.json()) as InventoryDataset;
  } catch {
    return NextResponse.json({ error: "inventory unavailable" }, { status: 502 });
  }

  const live = dataset.items.filter((it) => !it.archived);
  const sample = live.filter((it) => it.cost_cents > 0).slice(0, 5);
  const base = sample.length ? sample : live.slice(0, 5);

  const lines: {
    description: string;
    qty: number;
    unit: string;
    unit_price_cents: number;
    canonical_name?: string;
    brand?: string;
    pack?: string;
  }[] = base.map((it, i) => ({
    // UPPERCASE printed-style description (no SKU) — the client re-matches it.
    description: `${it.name.toUpperCase()} ${it.unit.toUpperCase()}`.trim(),
    qty: QTYS[i] ?? 6,
    unit: it.unit,
    // Bump the first line ~9% so an existing item shows the "Cambio de precio" chip.
    unit_price_cents: Math.round(it.cost_cents * (i === 0 ? 1.09 : 1)),
    // The model's clean normalization (ADR-0586 D4) — here just the item's
    // own name, so the stub exercises the canonical-name + alias-learning path in dev.
    canonical_name: it.name,
    pack: it.unit,
  }));

  // One unrecognized line so the new-SKU (inline-create) path is always exercised — with
  // a brand so the dev demo shows brand stripping into a clean canonical name.
  lines.push({
    description: "OATLY OAT MILK BARISTA 1/2 GAL",
    qty: 6,
    unit: "ctn",
    unit_price_cents: 510,
    canonical_name: "Oat Milk 1/2 gal",
    brand: "Oatly",
    pack: "1/2 gal",
  });

  const result = InventoryReceiptParseResultSchema.parse({ vendor: "Sam's Club", lines });
  // Mark stub output so it's never mistaken for a real scan. A header, not a body field
  // (the contract schema would strip an unknown key anyway), keeps the DTO clean.
  return NextResponse.json(result, { headers: { "X-Scan-Source": "stub" } });
}
