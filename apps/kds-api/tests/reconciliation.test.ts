import { afterEach, describe, expect, it, vi } from "vitest";
import { runReconciliationOnce } from "../src/jobs/reconciliation.js";
import { encryptSecretForStorage } from "../src/lib/pos-token.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("reconciliation job", () => {
  it("enqueues modified orders and updates lastReconciledAt without overwriting webhook status", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-22T10:00:00.000Z"));

    const enqueueBulk = vi.fn(async () => {});
    const update = vi.fn(async () => ({}));
    const fetchModifiedOrders = vi.fn(async () => ({
      elements: [
        { id: "order-1" },
        { id: "order-2" }
      ]
    }));

    await runReconciliationOnce({
      queue: {
        enqueueBulk
      },
      clover: {
        fetchModifiedOrders
      },
      prisma: {
        cloverMerchant: {
          findMany: vi.fn(async () => [
            {
              id: "merchant-1",
              authStatus: "ACTIVE",
              lastReconciledAt: null
            }
          ]),
          update
        },
        kdsFilter: {
          findMany: vi.fn(async () => [])
        },
        deadLetterJob: {
          create: vi.fn(async () => ({}))
        }
      },
      config: {
        reconcileIntervalMs: 45_000
      }
    } as never);

    expect(fetchModifiedOrders).toHaveBeenCalledWith(
      "merchant-1",
      expect.any(Date),
      { bucket: "recon" }
    );
    expect(enqueueBulk).toHaveBeenCalledWith([
      expect.objectContaining({
        provider: "CLOVER",
        merchantId: "merchant-1",
        sourceOrderId: "order-1",
        reason: "reconciliation"
      }),
      expect.objectContaining({
        provider: "CLOVER",
        merchantId: "merchant-1",
        sourceOrderId: "order-2",
        reason: "reconciliation"
      })
    ]);
    expect(update).toHaveBeenCalledWith({
      where: { id: "merchant-1" },
      data: {
        lastReconciledAt: expect.any(Date)
      }
    });
    expect(update.mock.calls[0]?.[0]?.data).not.toHaveProperty("webhookStatus");
  });

  it("polls a Square store via SearchOrders, NOT Clover's fetchModifiedOrders", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-18T10:00:00.000Z"));

    const enqueueBulk = vi.fn(async () => {});
    const update = vi.fn(async () => ({}));
    const fetchModifiedOrders = vi.fn(async () => ({ elements: [] }));
    const searchOrders = vi.fn(async () => [
      { id: "sqOrder1", updatedAt: "2026-06-18T09:59:00.000Z" },
      { id: "sqOrder2", updatedAt: "2026-06-18T09:59:30.000Z" }
    ]);

    // The PosStore row resolveSquareStoreCredentials + resolvePosAccessToken read
    // (one findUnique mock serves both — it ignores select/include).
    const squareRow = {
      id: "square:LOC1",
      providerStoreId: "LOC1",
      accessTokenCipher: null,
      posAccount: {
        provider: "SQUARE",
        environment: "PRODUCTION",
        accessTokenCipher: encryptSecretForStorage("sq-token")
      }
    };

    await runReconciliationOnce({
      queue: { enqueueBulk },
      clover: { fetchModifiedOrders },
      square: { searchOrders },
      prisma: {
        cloverMerchant: {
          findMany: vi.fn(async () => [
            { id: "square:LOC1", authStatus: "ACTIVE", lastReconciledAt: null, posAccount: { provider: "SQUARE" } }
          ]),
          findUnique: vi.fn(async () => squareRow),
          update
        },
        kdsFilter: { findMany: vi.fn(async () => []) },
        deadLetterJob: { create: vi.fn(async () => ({})) }
      },
      config: { reconcileIntervalMs: 45_000 }
    } as never);

    // The whole point: a Square row must NOT be Clover-polled.
    expect(fetchModifiedOrders).not.toHaveBeenCalled();
    // windowStart = now-5min = 09:55:00; search re-scans a 2-min overlap behind it
    // (09:53:00) so a late-indexed order can't slip past the advanced window.
    expect(searchOrders).toHaveBeenCalledWith("sq-token", "production", "LOC1", "2026-06-18T09:53:00.000Z");
    expect(enqueueBulk).toHaveBeenCalledWith([
      expect.objectContaining({
        provider: "SQUARE",
        merchantId: "square:LOC1",
        sourceOrderId: "sqOrder1",
        // keyed on the order's own updated_at, so an unchanged re-scan dedups
        idempotencyKey: "recon:square:LOC1:sqOrder1:2026-06-18T09:59:00.000Z"
      }),
      expect.objectContaining({ provider: "SQUARE", merchantId: "square:LOC1", sourceOrderId: "sqOrder2" })
    ]);
    expect(update).toHaveBeenCalledWith({
      where: { id: "square:LOC1" },
      data: { lastReconciledAt: expect.any(Date) }
    });
  });
});
