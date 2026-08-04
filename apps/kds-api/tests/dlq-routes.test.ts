import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppServices } from "../src/lib/services.js";
import { registerDlqRoutes } from "../src/routes/dlq.js";

// GH #124 / ADR-0727: the DLQ admin endpoints. Focus on the auth gate (it's a
// write endpoint that re-drives prod jobs) + the replay/resolve status branches.

const BEARER = "internal-admin-token-1234567890";
const AUTH = { authorization: `Bearer ${BEARER}` };

function row(over: Record<string, unknown> = {}) {
  return {
    id: "dl1",
    merchantId: "M1",
    jobType: "sync-order",
    reason: "boom",
    attempts: 3,
    payload: { queue: "kds-sync-hi", jobId: "1", data: { provider: "CLOVER", merchantId: "M1", sourceOrderId: "o1", reason: "reconciliation" } },
    createdAt: new Date("2026-06-17T00:00:00Z"),
    resolvedAt: null,
    ...over
  };
}

function buildServices(over: { prisma?: Record<string, unknown>; queue?: Record<string, unknown> } = {}): AppServices {
  return {
    config: { kdsInternalAdminToken: BEARER },
    queue: {
      enqueueBulk: vi.fn(async () => {}),
      enqueueFulfillment: vi.fn(async () => {}),
      ...over.queue
    },
    prisma: {
      deadLetterJob: {
        findMany: vi.fn(async () => [row()]),
        findUnique: vi.fn(async () => row()),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => row({ resolvedAt: data.resolvedAt })),
        updateMany: vi.fn(async () => ({ count: 1 })),
        ...over.prisma
      }
    }
  } as unknown as AppServices;
}

async function app(services: AppServices) {
  const instance = Fastify();
  await registerDlqRoutes(instance, services);
  return instance;
}

describe("DLQ admin endpoints (GH #124 / ADR-0727)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("rejects an unauthenticated request (401)", async () => {
    const instance = await app(buildServices());
    const res = await instance.inject({ method: "GET", url: "/api/admin/dlq" });
    expect(res.statusCode).toBe(401);
    await instance.close();
  });

  it("lists unresolved rows with the bearer", async () => {
    const instance = await app(buildServices());
    const res = await instance.inject({ method: "GET", url: "/api/admin/dlq", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { jobs: Array<{ id: string; jobType: string }> };
    expect(body.jobs[0]?.id).toBe("dl1");
    // payload is NOT serialized out (internal shape stays server-side)
    expect(JSON.stringify(body)).not.toContain("kds-sync-hi");
    await instance.close();
  });

  it("replays a sync-order row: re-enqueues then marks resolved", async () => {
    const services = buildServices();
    const instance = await app(services);
    const res = await instance.inject({ method: "POST", url: "/api/admin/dlq/dl1/replay", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect((services.queue.enqueueBulk as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
    expect((services.prisma.deadLetterJob.update as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
    await instance.close();
  });

  it("returns 409 when replaying an already-resolved row (and does NOT re-enqueue)", async () => {
    const services = buildServices({
      prisma: { findUnique: vi.fn(async () => row({ resolvedAt: new Date() })) }
    });
    const instance = await app(services);
    const res = await instance.inject({ method: "POST", url: "/api/admin/dlq/dl1/replay", headers: AUTH });
    expect(res.statusCode).toBe(409);
    expect((services.queue.enqueueBulk as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    await instance.close();
  });

  it("returns 422 for a non-replayable job type and does NOT mark resolved", async () => {
    const services = buildServices({
      prisma: { findUnique: vi.fn(async () => row({ jobType: "reconciliation", payload: { data: { task: "reconciliation" } } })) }
    });
    const instance = await app(services);
    const res = await instance.inject({ method: "POST", url: "/api/admin/dlq/dl1/replay", headers: AUTH });
    expect(res.statusCode).toBe(422);
    expect((services.prisma.deadLetterJob.update as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    await instance.close();
  });

  it("returns 404 replaying a missing row", async () => {
    const services = buildServices({ prisma: { findUnique: vi.fn(async () => null) } });
    const instance = await app(services);
    const res = await instance.inject({ method: "POST", url: "/api/admin/dlq/nope/replay", headers: AUTH });
    expect(res.statusCode).toBe(404);
    await instance.close();
  });

  it("resolves a row without replay (200), 404 when missing", async () => {
    const ok = await app(buildServices());
    expect((await ok.inject({ method: "POST", url: "/api/admin/dlq/dl1/resolve", headers: AUTH })).statusCode).toBe(200);
    await ok.close();

    const missing = await app(
      buildServices({ prisma: { updateMany: vi.fn(async () => ({ count: 0 })), findUnique: vi.fn(async () => null) } })
    );
    expect((await missing.inject({ method: "POST", url: "/api/admin/dlq/nope/resolve", headers: AUTH })).statusCode).toBe(404);
    await missing.close();
  });
});
