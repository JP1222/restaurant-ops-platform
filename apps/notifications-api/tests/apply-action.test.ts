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

const KEY = "notif-act-1-hide-salmon";

// A notification carrying a suggested-action AI block (the only kind the apply
// endpoint acts on).
const withAction = {
  id: "act-1",
  ai: {
    text: "Salmon is out of stock across two counts.",
    block: {
      kind: "action",
      label: "Suggested action",
      icon: "zap",
      title: "86 the salmon roll",
      hint: "Out of stock",
      action: {
        id: "hide-salmon",
        applyLabel: "86 it",
        confirmPrompt: "86 the salmon roll on the display?",
        doneLabel: "Salmon roll 86'd",
        endpoint: "/api/notifications/act-1/actions/apply",
        idempotencyKey: KEY
      }
    }
  }
};

// A notification with no action block — apply must refuse it.
const noAction = { id: "no-action", ai: null };

const byId: Record<string, { id: string; ai: unknown }> = {
  "act-1": withAction,
  "no-action": noAction
};

const auditCreate = vi.fn(async () => ({ id: "audit-1" }));

const fakePrisma = {
  notification: {
    findUnique: async ({ where }: { where: { id: string } }) => byId[where.id] ?? null
  },
  notificationActionAudit: { create: auditCreate },
  $queryRaw: async () => [{ ok: 1 }],
  $disconnect: async () => {}
} as unknown as PrismaClient;

const manager = {
  authorization: `Bearer ${INTERNAL}`,
  "x-operator-id": OPERATOR,
  "x-operator-role": "MANAGER"
};

const body = { notificationId: "act-1", actionId: "hide-salmon", idempotencyKey: KEY };

function apply(id: string, headers: Record<string, string>, payload: unknown = body) {
  return app.inject({ method: "POST", url: `/api/notifications/${id}/actions/apply`, headers, payload });
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
  auditCreate.mockClear();
  auditCreate.mockImplementation(async () => ({ id: "audit-1" }));
});

describe("POST /api/notifications/:id/actions/apply — gate", () => {
  it("403s without a role header (operator id alone is not enough)", async () => {
    const res = await apply("act-1", { authorization: `Bearer ${INTERNAL}`, "x-operator-id": OPERATOR });
    expect(res.statusCode).toBe(403);
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it("403s for a non-manager role", async () => {
    const res = await apply("act-1", { ...manager, "x-operator-role": "STAFF" });
    expect(res.statusCode).toBe(403);
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it("401s without the internal bearer", async () => {
    const res = await apply("act-1", { "x-operator-id": OPERATOR, "x-operator-role": "MANAGER" });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /api/notifications/:id/actions/apply — apply", () => {
  it("applies once and records the audit row with operator + role", async () => {
    const res = await apply("act-1", manager);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "applied", doneLabel: "Salmon roll 86'd" });
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(auditCreate).toHaveBeenCalledWith({
      data: {
        notificationId: "act-1",
        actionId: "hide-salmon",
        idempotencyKey: KEY,
        operatorId: OPERATOR,
        operatorRole: "MANAGER"
      }
    });
  });

  it("returns already_applied on a duplicate idempotency key (no double-apply)", async () => {
    auditCreate.mockImplementationOnce(async () => {
      throw { code: "P2002" };
    });
    const res = await apply("act-1", manager);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "already_applied", doneLabel: "Salmon roll 86'd" });
  });
});

describe("POST /api/notifications/:id/actions/apply — validation", () => {
  it("404s for an unknown notification", async () => {
    const res = await apply("does-not-exist", manager, {
      notificationId: "does-not-exist",
      actionId: "hide-salmon",
      idempotencyKey: KEY
    });
    expect(res.statusCode).toBe(404);
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it("400s when the body notificationId disagrees with the route", async () => {
    const res = await apply("act-1", manager, { ...body, notificationId: "other" });
    expect(res.statusCode).toBe(400);
  });

  it("400s on a malformed body (missing idempotencyKey)", async () => {
    const res = await apply("act-1", manager, { notificationId: "act-1", actionId: "hide-salmon" });
    expect(res.statusCode).toBe(400);
  });

  it("409s when the notification carries no suggested action", async () => {
    const res = await apply("no-action", manager, {
      notificationId: "no-action",
      actionId: "hide-salmon",
      idempotencyKey: KEY
    });
    expect(res.statusCode).toBe(409);
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it("409s when the actionId / idempotencyKey do not match the notification's action", async () => {
    const res = await apply("act-1", manager, { ...body, idempotencyKey: "forged-key" });
    expect(res.statusCode).toBe(409);
    expect(auditCreate).not.toHaveBeenCalled();
  });
});
