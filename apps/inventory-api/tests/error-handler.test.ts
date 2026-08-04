import Fastify, { type FastifyInstance } from "fastify";
import type { PrismaClient } from "@rop/db-inventory";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { registerErrorHandlers } from "../src/lib/error-handler.js";

// The verbatim bootstrap error from lib/inventory-store.ts that must NOT reach a
// production client (issue #152). If this string ever appears in a prod response
// body the redaction has regressed.
const RAW_LEAK = "Inventory database is not initialized: missing waste_settings (run the seed).";

function buildHarness(nodeEnv: AppConfig["nodeEnv"]): FastifyInstance {
  // logger:false keeps the test output clean; the handler still calls req.log.*
  // (Fastify provides a no-op logger when disabled).
  const app = Fastify({ logger: false });
  registerErrorHandlers(app, { nodeEnv } as AppConfig);

  app.get("/boom", async () => {
    throw new Error(RAW_LEAK);
  });

  // Simulate a Prisma known-request error by duck-typing `.code` (the handler
  // matches on the code, not the class — same convention as lib/crew-admin.ts).
  app.get("/fk", async () => {
    const err = new Error("Foreign key constraint failed on the field: `vendorId`") as Error & {
      code: string;
    };
    err.code = "P2003";
    throw err;
  });

  app.get("/gone", async () => {
    const err = new Error(
      "An operation failed because it depends on one or more records that were required but not found"
    ) as Error & { code: string };
    err.code = "P2025";
    throw err;
  });

  return app;
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("setErrorHandler — production redaction", () => {
  it("redacts a thrown 500 to a generic message + request_id (no raw exception text)", async () => {
    app = buildHarness("production");
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/boom" });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.error).toBe("Internal server error");
    expect(body.request_id).toBeTruthy();
    // The raw exception text + Prisma-style detail must be absent.
    expect(res.payload).not.toContain(RAW_LEAK);
    expect(res.payload).not.toContain("waste_settings");
    // request_id is also surfaced as a header for log correlation.
    expect(res.headers["x-request-id"]).toBe(body.request_id);
  });
});

describe("setErrorHandler — development passthrough", () => {
  it("returns the real message in development (still with a request_id)", async () => {
    app = buildHarness("development");
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/boom" });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.error).toBe(RAW_LEAK);
    expect(body.request_id).toBeTruthy();
  });
});

describe("setErrorHandler — Prisma code mapping", () => {
  it("maps P2003 to 400 with a generic body (no constraint/column leak)", async () => {
    app = buildHarness("production");
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/fk" });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("Invalid reference");
    expect(body.request_id).toBeTruthy();
    expect(res.payload).not.toContain("vendorId");
    expect(res.payload).not.toContain("constraint");
  });

  it("maps P2025 to 404 with a generic body", async () => {
    app = buildHarness("production");
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/gone" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("Not found");
  });

  // Prisma mapping is by code, not env — a P2003 is a client error in dev too.
  it("maps known Prisma codes even in development", async () => {
    app = buildHarness("development");
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/fk" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Invalid reference");
  });
});

describe("setNotFoundHandler", () => {
  it("returns { error: 'Not found' } + request_id without echoing the path", async () => {
    app = buildHarness("production");
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/api/does-not-exist/secret-probe" });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error).toBe("Not found");
    expect(body.request_id).toBeTruthy();
    // The requested path must not be reflected back (Fastify's default 404 body
    // includes method + url; ours must not).
    expect(res.payload).not.toContain("secret-probe");
    expect(res.payload).not.toContain("does-not-exist");
    expect(res.headers["x-request-id"]).toBe(body.request_id);
  });
});

// End-to-end through buildApp (not just the unit): a real route whose Prisma
// access throws the verbatim bootstrap error must be redacted in production.
// This proves the handler is actually WIRED into the app, not merely correct in
// isolation. GET /api/inventory/pos/:id is an open read whose store helper makes
// a single findUnique first, so a throw there yields no orphan Promise.all legs.
describe("buildApp wiring — production redacts a thrown store error", () => {
  const prodConfig: AppConfig = {
    nodeEnv: "production",
    apiPort: 4100,
    inventoryDatabaseUrl: "postgresql://test",
    backofficeBaseUrl: "http://localhost:3001",
    crewBaseUrl: "http://localhost:3003",
    internalToken: "test-internal-token-0000000000",
    crewSessionSecret: "test-session-secret-0000000000",
    crewPinPepper: "test-pin-pepper-0000000000"
  };

  const throwingPrisma = {
    inventoryPurchaseOrder: {
      findUnique: async () => {
        throw new Error(RAW_LEAK);
      }
    },
    $disconnect: async () => {}
  } as unknown as PrismaClient;

  it("returns a generic body (no raw store error) from GET /api/inventory/pos/:id", async () => {
    const built = await buildApp({ config: prodConfig, prisma: throwingPrisma });
    await built.ready();
    try {
      const res = await built.inject({ method: "GET", url: "/api/inventory/pos/PO-1" });
      expect(res.statusCode).toBe(500);
      const body = res.json();
      expect(body.error).toBe("Internal server error");
      expect(body.request_id).toBeTruthy();
      expect(res.payload).not.toContain("waste_settings");
    } finally {
      await built.close();
    }
  });

  // Cross-service correlation wiring (AI-benchmark §3.1): buildApp sets
  // requestIdHeader: "x-request-id", so a caller-supplied id (the backoffice BFF)
  // becomes request.id and is echoed back — one id ties the BFF call and these
  // logs together in Loki.
  it("adopts a caller-supplied x-request-id as request.id (echoed back)", async () => {
    const built = await buildApp({ config: prodConfig, prisma: throwingPrisma });
    await built.ready();
    try {
      const correlationId = "bff-corr-0123456789";
      const res = await built.inject({
        method: "GET",
        url: "/api/inventory/pos/PO-1",
        headers: { "x-request-id": correlationId }
      });
      expect(res.headers["x-request-id"]).toBe(correlationId);
      expect(res.json().request_id).toBe(correlationId);
    } finally {
      await built.close();
    }
  });
});
