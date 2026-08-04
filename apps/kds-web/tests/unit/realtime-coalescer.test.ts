import { describe, expect, it } from "vitest";
import { coalesceRealtimeEvents } from "@/lib/realtime-coalescer";

describe("realtime coalescer", () => {
  it("keeps only the latest event per ticket while preserving latest order", () => {
    const events = coalesceRealtimeEvents([
      { type: "ticket.created", ticket: { id: "ticket-1" } },
      { type: "ticket.created", ticket: { id: "ticket-2" } },
      { type: "ticket.updated", ticket: { id: "ticket-1" } }
    ]);

    expect(events).toEqual([
      { type: "ticket.created", ticket: { id: "ticket-2" } },
      { type: "ticket.updated", ticket: { id: "ticket-1" } }
    ]);
  });
});
