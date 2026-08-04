import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { CREW_COOKIE } from "@/lib/server/inventory-api";

export const dynamic = "force-dynamic";

// Crew AI emoji-icon suggestion. crew-web has no AI provider of its own, so — exactly like
// the scan + match-suggest routes — it proxies to backoffice's /api/inventory/emoji-suggest
// with the shared INTERNAL_AI_TOKEN bearer.
//
// This is a pure cosmetic ENHANCEMENT (it only ever sets an emoji on an icon-less item), so
// an unconfigured / failing upstream returns an EMPTY suggestion set rather than an error:
// the item just keeps its category-glyph fallback. Nothing here can import bad data.
const EMPTY = { suggestions: [] };

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
    const upstream = await fetch(`${backofficeUrl}/api/inventory/emoji-suggest`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${aiToken}` },
      body: JSON.stringify(body),
    });
    if (!upstream.ok) {
      return NextResponse.json(EMPTY);
    }
    const text = await upstream.text();
    return new NextResponse(text, {
      status: 200,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
    });
  } catch {
    return NextResponse.json(EMPTY);
  }
}
