import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { CREW_COOKIE, inventoryApiUrl } from "@/lib/server/inventory-api";

export async function GET() {
  const token = (await cookies()).get(CREW_COOKIE)?.value;
  if (!token) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(inventoryApiUrl("/api/crew/me"), {
      headers: { cookie: `${CREW_COOKIE}=${token}` }
    });
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 502 });
  }

  if (!upstream.ok) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json(await upstream.json());
}
