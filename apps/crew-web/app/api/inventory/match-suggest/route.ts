import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { CREW_COOKIE } from "@/lib/server/inventory-api";

export const dynamic = "force-dynamic";

// Crew AI semantic match (ADR-0587). crew-web has no AI provider of its own, so — exactly
// like the scan route (ADR-0538) — it proxies the residual unmatched lines to backoffice's
// /api/inventory/match-suggest (the chat brain) with the shared INTERNAL_AI_TOKEN bearer.
//
// This tier is a best-effort ENHANCEMENT on top of the deterministic client matching, so an
// unconfigured / failing upstream returns an EMPTY suggestion set (threshold 1 = nothing
// auto-applies) rather than an error: the scan review simply stays on its deterministic
// matches. (Unlike the scan route, there is nothing unsafe to fail open to here — an empty
// suggestion list can't import bad data.)
const EMPTY = { suggestions: [], threshold: 1 };

export async function POST(request: Request): Promise<Response> {
  const token = (await cookies()).get(CREW_COOKIE)?.value;
  if (!token) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const aiToken = process.env.INTERNAL_AI_TOKEN;
  const backofficeUrl = process.env.INTERNAL_BACKOFFICE_URL;
  if (!aiToken || !backofficeUrl) {
    return NextResponse.json(EMPTY);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  try {
    const upstream = await fetch(`${backofficeUrl}/api/inventory/match-suggest`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${aiToken}` },
      body: JSON.stringify(body)
    });
    if (!upstream.ok) {
      return NextResponse.json(EMPTY);
    }
    const text = await upstream.text();
    return new NextResponse(text, {
      status: 200,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" }
    });
  } catch {
    return NextResponse.json(EMPTY);
  }
}
