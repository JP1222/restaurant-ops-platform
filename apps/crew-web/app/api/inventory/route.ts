import { NextResponse } from "next/server";

import { inventoryApiUrl } from "@/lib/server/inventory-api";

export async function GET() {
  let upstream: Response;
  try {
    upstream = await fetch(inventoryApiUrl("/api/inventory"), { cache: "no-store" });
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 502 });
  }
  if (!upstream.ok) {
    return NextResponse.json({ error: "unavailable" }, { status: 502 });
  }
  return NextResponse.json(await upstream.json());
}
