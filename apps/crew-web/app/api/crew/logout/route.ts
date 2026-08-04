import { NextResponse } from "next/server";

import { CREW_COOKIE } from "@/lib/server/inventory-api";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(CREW_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
