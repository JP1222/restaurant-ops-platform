import { describe, expect, it } from "vitest";
import { KdsTicketStatus } from "@rop/db-kds";
import { nextStatus } from "../src/domain/state-machine.js";

describe("nextStatus", () => {
  it("progresses through the kitchen flow", () => {
    expect(nextStatus(KdsTicketStatus.NEW, "acknowledge")).toBe(KdsTicketStatus.ACKNOWLEDGED);
    expect(nextStatus(KdsTicketStatus.ACKNOWLEDGED, "start")).toBe(KdsTicketStatus.IN_PROGRESS);
    expect(nextStatus(KdsTicketStatus.IN_PROGRESS, "ready")).toBe(KdsTicketStatus.READY);
    expect(nextStatus(KdsTicketStatus.READY, "complete")).toBe(KdsTicketStatus.COMPLETED);
  });

  it("supports a single-step kitchen completion flow", () => {
    expect(nextStatus(KdsTicketStatus.NEW, "complete")).toBe(KdsTicketStatus.COMPLETED);
    expect(nextStatus(KdsTicketStatus.ACKNOWLEDGED, "complete")).toBe(KdsTicketStatus.COMPLETED);
    expect(nextStatus(KdsTicketStatus.IN_PROGRESS, "complete")).toBe(KdsTicketStatus.COMPLETED);
    expect(nextStatus(KdsTicketStatus.READY, "complete")).toBe(KdsTicketStatus.COMPLETED);
  });

  it("supports bump and recall", () => {
    expect(nextStatus(KdsTicketStatus.READY, "bump")).toBe(KdsTicketStatus.COMPLETED);
    expect(nextStatus(KdsTicketStatus.COMPLETED, "recall")).toBe(KdsTicketStatus.READY);
  });

  it("supports hold and fire without affecting the main kitchen flow", () => {
    expect(nextStatus(KdsTicketStatus.NEW, "hold")).toBe(KdsTicketStatus.ON_HOLD);
    expect(nextStatus(KdsTicketStatus.ON_HOLD, "fire")).toBe(KdsTicketStatus.NEW);
  });
});
