import { NextResponse } from "next/server";

import { inventoryApiUrl } from "@/lib/server/inventory-api";

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  let upstream: Response;
  try {
    upstream = await fetch(inventoryApiUrl(`/api/inventory/pos/${encodeURIComponent(id)}`), {
      cache: "no-store"
    });
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 502 });
  }
  if (!upstream.ok) {
    return NextResponse.json({ error: "unavailable" }, { status: upstream.status });
  }
  return NextResponse.json(await upstream.json());
}
