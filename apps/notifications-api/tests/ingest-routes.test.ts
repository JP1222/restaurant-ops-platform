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

const notifFindUnique = vi.fn(async (_args: unknown): Promise<{ id: string } | null> => null);
// create returns the FULL row — the realtime fanout maps it via toDto — so the mock
// echoes the data it was handed plus the DB-generated id + createdAt.
const createdRow = (args: { data: Record<string, unknown> }) => ({
  id: "new-1",
  createdAt: new Date("2025-05-22T17:00:00.000Z"),
  ai: null,
  ...args.data
});
const notifCreate = vi.fn(createdRow);

const fakePrisma = {
  notification: { findUnique: notifFindUnique, create: notifCreate },
  $queryRaw: async () => [{ ok: 1 }],
  $disconnect: async () => {}
} as unknown as PrismaClient;

const bearer = { authorization: `Bearer ${INTERNAL}` };

const body = {
  severity: "warn",
  category: "inv",
  categoryLabel: "Inventory",
  icon: "package",
  title: "Salmon roll 86'd",
  detail: "Marked unavailable on the line",
  action: { label: "View item", icon: "external-link", href: "/inventory/items/salmon" },
  dedupeKey: "inv:86:salmon"
};

function ingest(payload: unknown, headers: Record<string, string> = bearer) {
  return app.inject({ method: "POST", url: "/api/notifications/ingest", headers, payload });
}

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  app = await buildApp({ config, prisma: fakePrisma });
  await app.ready();
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  notifFindUnique.mockReset();
  notifFindUnique.mockResolvedValue(null);
  notifCreate.mockReset();
  notifCreate.mockImplementation(createdRow);
});

describe("POST /api/notifications/ingest", () => {
  it("401s without the internal bearer", async () => {
    const res = await ingest(body, {});
    expect(res.statusCode).toBe(401);
    expect(notifCreate).not.toHaveBeenCalled();
  });

  it("creates a notification (201, status created) mapping action fields", async () => {
    const res = await ingest(body);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ id: "new-1", status: "created" });
    expect(notifCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          severity: "warn",
          category: "inv",
          categoryLabel: "Inventory",
          actionLabel: "View item",
          actionIcon: "external-link",
          actionHref: "/inventory/items/salmon",
          dedupeKey: "inv:86:salmon",
          locationId: null
        })
      })
    );
  });

  it("is idempotent on dedupeKey — returns the existing row, no create", async () => {
    notifFindUnique.mockResolvedValueOnce({ id: "existing-1" });
    const res = await ingest(body);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: "existing-1", status: "duplicate" });
    expect(notifCreate).not.toHaveBeenCalled();
  });

  it("always creates when no dedupeKey is given (no dedupe lookup)", async () => {
    const { dedupeKey: _omit, ...noKey } = body;
    const res = await ingest(noKey);
    expect(res.statusCode).toBe(201);
    expect(notifFindUnique).not.toHaveBeenCalled();
    expect(notifCreate).toHaveBeenCalledTimes(1);
  });

  it("treats a unique-violation race as a duplicate", async () => {
    notifFindUnique.mockResolvedValueOnce(null); // pre-check: not there yet
    notifCreate.mockRejectedValueOnce({ code: "P2002" }); // concurrent insert won
    notifFindUnique.mockResolvedValueOnce({ id: "existing-race" }); // re-read finds it
    const res = await ingest(body);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: "existing-race", status: "duplicate" });
  });

  it("400s on a malformed body (missing title)", async () => {
    const { title: _omit, ...bad } = body;
    const res = await ingest(bad);
    expect(res.statusCode).toBe(400);
    expect(notifCreate).not.toHaveBeenCalled();
  });
});
