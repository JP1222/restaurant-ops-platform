import { describe, expect, it } from "vitest";
import { KdsTicketStatus } from "@rop/db-kds";
import type { KdsAction } from "@rop/contracts";
import { shouldWriteBackFulfillment } from "../src/lib/sync-order.js";
import { nextStatus } from "../src/domain/state-machine.js";

// A provider fulfillment event must fire once per real transition. A client
// outbox replaying an action after a reconnect lands on an already-applied
// status, which must NOT re-emit a duplicate Clover/Deliverect fulfillment
// event. These assert the gate is keyed on an actual status change.
const writesBack = (from: KdsTicketStatus, action: KdsAction) =>
  shouldWriteBackFulfillment(from, nextStatus(from, action));

describe("shouldWriteBackFulfillment", () => {
  it("does NOT write back when a replayed action is a no-op (status unchanged)", () => {
    expect(writesBack(KdsTicketStatus.COMPLETED, "bump")).toBe(false);
    expect(writesBack(KdsTicketStatus.COMPLETED, "complete")).toBe(false);
    expect(writesBack(KdsTicketStatus.COMPLETED, "acknowledge")).toBe(false);
    expect(writesBack(KdsTicketStatus.READY, "ready")).toBe(false);
    expect(writesBack(KdsTicketStatus.ON_HOLD, "hold")).toBe(false);
    // fire only releases an on-hold ticket; firing an already-live ticket is a no-op.
    expect(writesBack(KdsTicketStatus.NEW, "fire")).toBe(false);
  });

  it("writes back on a real state transition", () => {
    expect(writesBack(KdsTicketStatus.NEW, "start")).toBe(true);
    expect(writesBack(KdsTicketStatus.IN_PROGRESS, "ready")).toBe(true);
    expect(writesBack(KdsTicketStatus.IN_PROGRESS, "bump")).toBe(true);
    expect(writesBack(KdsTicketStatus.NEW, "hold")).toBe(true);
    expect(writesBack(KdsTicketStatus.ON_HOLD, "fire")).toBe(true);
    expect(writesBack(KdsTicketStatus.COMPLETED, "recall")).toBe(true);
  });

  it("is a pure status-equality check independent of the action label", () => {
    expect(shouldWriteBackFulfillment(KdsTicketStatus.READY, KdsTicketStatus.READY)).toBe(false);
    expect(shouldWriteBackFulfillment(KdsTicketStatus.NEW, KdsTicketStatus.IN_PROGRESS)).toBe(true);
  });
});
