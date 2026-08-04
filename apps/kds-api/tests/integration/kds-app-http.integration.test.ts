import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startKdsHttpItContext, type KdsHttpItContext } from "./fixture.js";

// The full-app follow-up to kds-shared-db: boots the real createServices ->
// buildApp path over real Postgres + Redis and serves HTTP via app.inject().
// /api/ready actively pings both backing services (Prisma SELECT 1 + Redis
// PING), so a 200 proves the whole stack is wired to live infrastructure, not a
// mock.
describe("kds-api integration (full app over real Postgres + Redis)", () => {
  let ctx: KdsHttpItContext;

  beforeAll(async () => {
    ctx = await startKdsHttpItContext();
  });

  afterAll(async () => {
    await ctx?.stop();
  });

  it("GET /api/health → 200 liveness once the app has booted", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it("GET /api/ready → 200 with database + redis both reachable", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/api/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, checks: { database: "ok", redis: "ok" } });
  });
});
