import type { PrismaClient } from "@rop/db-notifications";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";

const INTERNAL = "test-internal-token-000000000000";

const config: AppConfig = {
  nodeEnv: "test",
  apiPort: 4400,
  notificationsDatabaseUrl: "postgresql://test",
  internalToken: INTERNAL,
  allowedOrigins: undefined
};

const prefUpsert = vi.fn(async () => ({}));
const catUpsert = vi.fn(async () => ({}));

const fakePrisma = {
  // No stored row → the service answers with suite defaults.
  notificationPref: { findUnique: async () => null, upsert: prefUpsert },
  notificationCategoryPref: { upsert: catUpsert },
  $transaction: async (arr: Promise<unknown>[]) => Promise.all(arr),
  $disconnect: async () => {}
} as unknown as PrismaClient;

const auth = { authorization: `Bearer ${INTERNAL}`, "x-operator-id": "op-1" };

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  app = await buildApp({ config, prisma: fakePrisma });
  await app.ready();
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  prefUpsert.mockClear();
  catUpsert.mockClear();
});

describe("GET /api/notifications/prefs", () => {
  it("returns the full default set when nothing is stored", async () => {
    const res = await app.inject({ method: "GET", url: "/api/notifications/prefs", headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body.cats).sort()).toEqual(["cost", "dev", "intg", "inv", "sales"]);
    expect(body.quiet).toBe(true);
    expect(body.cats.dev.sev).toBe("crit");
    expect(body.cats.sales.label).toBe("Sales");
  });
});

describe("PATCH /api/notifications/prefs", () => {
  it("rejects an invalid patch", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/notifications/prefs",
      headers: auth,
      payload: { quiet: "yes" }
    });
    expect(res.statusCode).toBe(400);
  });

  it("upserts the quiet row and only the touched category cell", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/notifications/prefs",
      headers: auth,
      payload: { quiet: false, cats: { inv: { email: true } } }
    });
    expect(res.statusCode).toBe(200);
    expect(prefUpsert).toHaveBeenCalledTimes(1);
    expect(prefUpsert.mock.calls[0][0]).toMatchObject({ update: { quiet: false } });
    expect(catUpsert).toHaveBeenCalledTimes(1);
    expect(catUpsert.mock.calls[0][0]).toMatchObject({
      where: { operatorId_category: { operatorId: "op-1", category: "inv" } },
      update: { email: true }
    });
  });
});
