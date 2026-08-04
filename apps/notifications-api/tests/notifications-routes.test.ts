import type { PrismaClient } from "@rop/db-notifications";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";

const INTERNAL = "test-internal-token-000000000000";
const OPERATOR = "op-1";

const config: AppConfig = {
  nodeEnv: "test",
  apiPort: 4400,
  notificationsDatabaseUrl: "postgresql://test",
  internalToken: INTERNAL,
  allowedOrigins: undefined
};

function makeNotification(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    severity: "info",
    category: "sales",
    categoryLabel: "Sales",
    icon: "trending-up",
    title: `Title ${id}`,
    detail: `Detail ${id}`,
    actionLabel: "Open",
    actionIcon: "external-link",
    actionHref: "/today",
    ai: null,
    createdAt: new Date("2025-05-22T17:00:00.000Z"),
    states: [] as Array<{ read: boolean; snoozedUntil: Date | null; dismissedAt: Date | null }>,
    ...over
  };
}

// id 1: unread (no state) · id 2: read · id 3: dismissed (not live)
const rows = [
  makeNotification("1", { severity: "crit" }),
  makeNotification("2", { states: [{ read: true, snoozedUntil: null, dismissedAt: null }] }),
  makeNotification("3", {
    states: [{ read: false, snoozedUntil: null, dismissedAt: new Date("2025-05-22T16:00:00.000Z") }]
  })
];

const stateUpsert = vi.fn(async () => ({}));

const fakePrisma = {
  notification: {
    findMany: async () => rows,
    findUnique: async ({ where }: { where: { id: string } }) =>
      rows.find((r) => r.id === where.id) ?? null
  },
  notificationState: { upsert: stateUpsert },
  $transaction: async (arr: Promise<unknown>[]) => Promise.all(arr),
  $queryRaw: async () => [{ ok: 1 }],
  $disconnect: async () => {}
} as unknown as PrismaClient;

const auth = { authorization: `Bearer ${INTERNAL}`, "x-operator-id": OPERATOR };

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  app = await buildApp({ config, prisma: fakePrisma });
  await app.ready();
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => stateUpsert.mockClear());

describe("health", () => {
  it("is public", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });
});

describe("auth + operator guards", () => {
  it("401s without the bearer token", async () => {
    const res = await app.inject({ method: "GET", url: "/api/notifications" });
    expect(res.statusCode).toBe(401);
  });

  it("400s with a bearer but no x-operator-id", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/notifications",
      headers: { authorization: `Bearer ${INTERNAL}` }
    });
    expect(res.statusCode).toBe(400);
  });

  it("400s the SSE /stream with a bearer but no x-operator-id (guarded before the hijack)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/notifications/stream",
      headers: { authorization: `Bearer ${INTERNAL}` }
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/notifications", () => {
  it("returns live rows overlaid with operator state, dropping dismissed", async () => {
    const res = await app.inject({ method: "GET", url: "/api/notifications", headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.notifications.map((n: { id: string }) => n.id)).toEqual(["1", "2"]);
    expect(body.unreadCount).toBe(1);
    const first = body.notifications[0];
    expect(first).toMatchObject({ id: "1", read: false, action: { href: "/today" } });
  });
});

describe("state mutations", () => {
  it("marks one read (idempotent upsert)", async () => {
    const res = await app.inject({ method: "POST", url: "/api/notifications/1/read", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(stateUpsert).toHaveBeenCalledTimes(1);
    expect(stateUpsert.mock.calls[0][0]).toMatchObject({ update: { read: true } });
  });

  it("404s on a read for an unknown notification", async () => {
    const res = await app.inject({ method: "POST", url: "/api/notifications/999/read", headers: auth });
    expect(res.statusCode).toBe(404);
    expect(stateUpsert).not.toHaveBeenCalled();
  });

  it("rejects a snooze in the past, accepts one in the future", async () => {
    const past = await app.inject({
      method: "POST",
      url: "/api/notifications/1/snooze",
      headers: auth,
      payload: { until: "2000-01-01T00:00:00.000Z" }
    });
    expect(past.statusCode).toBe(400);

    const future = new Date(Date.now() + 3_600_000).toISOString();
    const ok = await app.inject({
      method: "POST",
      url: "/api/notifications/1/snooze",
      headers: auth,
      payload: { until: future }
    });
    expect(ok.statusCode).toBe(200);
  });

  it("read-all only touches live unread rows", async () => {
    const res = await app.inject({ method: "POST", url: "/api/notifications/read-all", headers: auth });
    expect(res.statusCode).toBe(200);
    // Only id 1 is live + unread (id 2 already read, id 3 dismissed).
    expect(res.json().count).toBe(1);
    expect(stateUpsert).toHaveBeenCalledTimes(1);
  });
});
