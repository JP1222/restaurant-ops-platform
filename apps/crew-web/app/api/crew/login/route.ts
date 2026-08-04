import { NextResponse } from "next/server";

import { crewIpAllowed } from "@/lib/server/crew-ip-gate";
import { CREW_COOKIE, inventoryApiUrl } from "@/lib/server/inventory-api";

export async function POST(req: Request) {
  // Floor-login IP gate (manager-configured allowlist). Reject before we even
  // forward the PIN, so a non-allowlisted network can't brute-force the keypad.
  if (!(await crewIpAllowed(req))) {
    return NextResponse.json({ error: "ip_not_allowed" }, { status: 403 });
  }

  let pin: unknown;
  try {
    pin = ((await req.json()) as { pin?: unknown })?.pin;
  } catch {
    pin = undefined;
  }

  let upstream: Response;
  try {
    upstream = await fetch(inventoryApiUrl("/api/crew/login"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pin })
    });
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 502 });
  }

  if (!upstream.ok) {
    return NextResponse.json({ error: "login failed" }, { status: upstream.status });
  }

  const data = (await upstream.json()) as { token: string; employee: unknown };
  const res = NextResponse.json({ employee: data.employee });
  res.cookies.set(CREW_COOKIE, data.token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 12 * 60 * 60
  });
  return res;
}
