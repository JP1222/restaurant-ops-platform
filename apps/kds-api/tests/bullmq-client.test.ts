import { describe, expect, it } from "vitest";
import {
  bullMqSafeId,
  KDS_QUEUE_NAMES,
  syncJobId
} from "../src/lib/queue/bullmq-client.js";

describe("BullMQ queue naming", () => {
  it("uses queue names without BullMQ's reserved colon separator", () => {
    expect(Object.values(KDS_QUEUE_NAMES)).toEqual([
      "kds-sync-hi",
      "kds-sync-lo",
      "kds-fulfillment",
      "kds-scheduler"
    ]);
    expect(Object.values(KDS_QUEUE_NAMES).every((name) => !name.includes(":"))).toBe(true);
  });

  it("normalizes generated job ids that include provider identifiers", () => {
    expect(bullMqSafeId("clover:merchant:order:webhook")).toBe("clover|merchant|order|webhook");
    expect(
      syncJobId({
        provider: "CLOVER",
        merchantId: "merchant:1",
        sourceOrderId: "order:1",
        reason: "webhook"
      })
    ).toBe("CLOVER|merchant|1|order|1|webhook");
  });
});
