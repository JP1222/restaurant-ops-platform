import { afterEach, describe, expect, test, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";

// Guards the edge exemption that lets the AI price-refresh cron reach its route
// handler with a bearer token instead of an operator session. The exemption was
// missing originally (#869), so the cron's POST was rejected by the session gate
// before the handler's own token check ever ran.
const TOKEN = "cron-secret-xyz";

function post(path: string, headers?: Record<string, string>) {
  return new NextRequest(`http://localhost:3001${path}`, { method: "POST", headers });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("proxy — AI price-refresh cron exemption", () => {
  test("a valid bearer on /api/ai/prices/refresh passes the session gate", async () => {
    vi.stubEnv("AI_PRICES_REFRESH_TOKEN", TOKEN);
    const res = await proxy(post("/api/ai/prices/refresh", { authorization: `Bearer ${TOKEN}` }));
    // NextResponse.next() — the request continues to the route handler.
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.status).not.toBe(401);
  });

  test("a wrong bearer falls through to the session gate (401)", async () => {
    vi.stubEnv("AI_PRICES_REFRESH_TOKEN", TOKEN);
    const res = await proxy(post("/api/ai/prices/refresh", { authorization: "Bearer nope" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "unauthenticated" });
  });

  test("dormant when the token is unset — a bearer can't bypass the gate", async () => {
    vi.stubEnv("AI_PRICES_REFRESH_TOKEN", "");
    const res = await proxy(post("/api/ai/prices/refresh", { authorization: "Bearer anything" }));
    expect(res.status).toBe(401);
  });

  test("the exemption is scoped to the price-refresh path only", async () => {
    vi.stubEnv("AI_PRICES_REFRESH_TOKEN", TOKEN);
    // Same token on a different /api route must NOT pass — it's not the cron path.
    const res = await proxy(post("/api/ai/usage", { authorization: `Bearer ${TOKEN}` }));
    expect(res.status).toBe(401);
  });
});
