import { describe, expect, it } from "vitest";
import { deadLetterRowForFailedAccrual } from "../src/worker-handler.js";

// GH #467: only the FINAL failed attempt is dead-lettered, the row strips the
// phone (PII) but keeps merchantId for forensics/replay, and the reason carries
// the error message.

const EVENT = {
  provider: "clover",
  merchantId: "M1",
  internalOrderId: "clover:M1:o1",
  occurredAt: "2026-06-16T12:00:00.000Z",
  phoneE164: "+15551234567",
  isRefund: false,
  items: [{ chargedCents: 800, isGiftCardPurchase: false, wasRewardRedemption: false }]
};

describe("deadLetterRowForFailedAccrual (GH #467)", () => {
  it("returns null when the job is undefined", () => {
    expect(deadLetterRowForFailedAccrual(undefined, new Error("x"))).toBeNull();
  });

  it("returns null while retries remain (not the final attempt)", () => {
    const row = deadLetterRowForFailedAccrual(
      { attemptsMade: 1, opts: { attempts: 3 }, data: EVENT },
      new Error("boom")
    );
    expect(row).toBeNull();
  });

  it("persists on the final attempt, stripping the phone but keeping merchantId", () => {
    const row = deadLetterRowForFailedAccrual(
      { attemptsMade: 3, opts: { attempts: 3 }, data: EVENT },
      new Error("accrual exploded")
    );
    expect(row).not.toBeNull();
    expect(row?.merchantId).toBe("M1");
    expect(row?.attempts).toBe(3);
    expect(row?.reason).toBe("accrual exploded");
    // PII must NOT be persisted.
    expect(JSON.stringify(row?.payload)).not.toContain("+15551234567");
    expect((row?.payload as Record<string, unknown>).phoneE164).toBeUndefined();
    // But the rest of the event is kept for replay.
    expect((row?.payload as Record<string, unknown>).internalOrderId).toBe("clover:M1:o1");
  });

  it("treats the first failure as terminal when no retry count is configured", () => {
    const row = deadLetterRowForFailedAccrual({ attemptsMade: 1, data: EVENT }, new Error("once"));
    expect(row).not.toBeNull();
    expect(row?.attempts).toBe(1);
  });

  it("tolerates a malformed payload (merchantId absent → null)", () => {
    const row = deadLetterRowForFailedAccrual(
      { attemptsMade: 1, data: { garbage: true } },
      "string error"
    );
    expect(row?.merchantId).toBeNull();
    expect(row?.reason).toBe("string error");
  });
});
