import { describe, expect, it } from "vitest";
import { KdsTicketStatus } from "@rop/db-kds";
import { toDisplayTicket } from "../src/lib/display.js";

describe("display serializer", () => {
  it("preserves the provider item name instead of replacing it with alternateName", () => {
    const ticket = toDisplayTicket({
      id: "ticket-1",
      merchantId: "merchant-1",
      orderLabel: "#73",
      sourceOrderId: "order-1",
      status: KdsTicketStatus.READY,
      createdAt: new Date("2026-04-24T20:00:00.000Z"),
      updatedAt: new Date("2026-04-24T20:03:00.000Z"),
      items: [
        {
          itemKey: "line-1",
          name: "Strawberry & Cheese Cake Rolled Ice Cream",
          alternateName: "Special#2",
          quantity: 1,
          refunded: false,
          completed: true
        }
      ]
    } as never);

    expect(ticket.items[0]).toMatchObject({
      name: "Strawberry & Cheese Cake Rolled Ice Cream",
      alternateName: "Special#2"
    });
  });
});
