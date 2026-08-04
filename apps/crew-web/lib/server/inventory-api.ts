import { cookies } from "next/headers";
import { NextResponse } from "next/server";

// Must match CREW_SESSION_COOKIE_NAME in @rop/auth. Kept as a local
// constant so crew-web stays decoupled from the auth package — it treats the
// session token as opaque (no crypto, no secret, no @rop/auth import).
export const CREW_COOKIE = "yr_crew_session";

// Server-side only. Never exposed to the browser.
export function inventoryApiUrl(path: string): string {
  const base = process.env.INVENTORY_API_BASE_URL ?? "http://localhost:4100";
  return `${base}${path}`;
}

// Forward a write to inventory-api carrying the crew session cookie so the API's
// dual-auth accepts it and derives the actor server-side. The `who` the caller
// includes is a placeholder the API overrides from the session. `method` covers
// catalog edits (PUT) and photo removal (DELETE) beyond the default POST; a DELETE
// carries no body.
export async function forwardCrewWrite(
  path: string,
  body: Record<string, unknown> | null,
  method: "POST" | "PUT" | "DELETE" = "POST"
): Promise<Response> {
  const token = (await cookies()).get(CREW_COOKIE)?.value;
  if (!token) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let upstream: Response;
  try {
    upstream = await fetch(inventoryApiUrl(path), {
      method,
      headers: { "content-type": "application/json", cookie: `${CREW_COOKIE}=${token}` },
      body: body === null ? undefined : JSON.stringify(body)
    });
  } catch {
    return NextResponse.json({ error: "inventory unavailable" }, { status: 502 });
  }
  const text = await upstream.text();
  return new NextResponse(text, {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" }
  });
}

// Proxy a public inventory-api GET back to the browser (e.g. an item photo).
// inventory-api isn't reachable from the browser — only crew-web's own origin is —
// so an <img src="/api/inventory/items/:id/image"> has to come through here. The
// image read is open (no crew cookie needed), so this forwards no auth and streams
// the bytes + content type straight through.
export async function proxyInventoryGet(path: string): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await fetch(inventoryApiUrl(path));
  } catch {
    return NextResponse.json({ error: "inventory unavailable" }, { status: 502 });
  }
  if (!upstream.ok) {
    return new NextResponse(null, { status: upstream.status });
  }
  const body = await upstream.arrayBuffer();
  return new NextResponse(body, {
    status: 200,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
      "cache-control": "no-cache"
    }
  });
}
