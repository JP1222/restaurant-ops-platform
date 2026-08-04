import { describe, expect, it } from "vitest";
import {
  DeliverectProviderSettingsSchema,
  KdsTicketSchema,
  KitchenBoardSettingsSchema,
  RealtimeEventSchema,
  RealtimeReceiptRequestSchema,
  TicketItemActionRequestSchema
} from "@rop/contracts";

describe("provider-neutral contract schemas", () => {
  it("parses board settings with urgency, modifier, and Deliverect config defaults", () => {
    const settings = KitchenBoardSettingsSchema.parse({
      filter: {
        allowedOrderTypes: [],
        blockedSources: [],
        paymentStates: [],
        createdAfterMinutes: null,
        searchText: "",
        includeCompleted: false,
        soundEnabled: true,
        screenPinEnabled: false
      },
      boardTimeZone: "UTC",
      dailyResetEnabled: false,
      dailyResetTime: "21:00"
    });

    expect(settings.urgencyWarningMinutes).toBe(10);
    expect(settings.urgencyCriticalMinutes).toBe(20);
    expect(settings.modifierDangerKeywords).toContain("allergy");
    expect(settings.display.weather).toEqual({
      enabled: true,
      zipCode: "00000",
      countryCode: "US",
      unit: "fahrenheit"
    });
    expect(settings.providers.deliverect.environment).toBe("staging");
  });

  it("parses provider-aware tickets with item completion fields", () => {
    const ticket = KdsTicketSchema.parse({
      id: "ticket-1",
      merchantId: "merchant-1",
      provider: "deliverect",
      cloverOrderId: "shadow-clover-id",
      sourceOrderId: "deliv-order-1",
      orderLabel: "#5001",
      status: "ready",
      priority: 2,
      source: "Uber Eats",
      orderType: "Delivery",
      paymentState: null,
      note: null,
      lastActor: "Expo",
      heldAt: null,
      holdUntil: null,
      displayChannelLabel: null,
      displayFulfillmentTimeLabel: null,
      hasLocalEdits: false,
      createdAt: "2026-04-21T21:00:00.000Z",
      updatedAt: "2026-04-21T21:05:00.000Z",
      elapsedMinutes: 5,
      items: [
        {
          id: "item-1",
          cloverLineItemId: null,
          providerLineItemId: "provider-line-1",
          itemKey: "provider-line-1",
          itemId: "catalog-1",
          name: "Burger",
          alternateName: null,
          note: "No onions",
          modifiers: ["Extra pickles"],
          quantity: 1,
          refunded: false,
          printed: true,
          completed: true,
          completedAt: "2026-04-21T21:04:00.000Z",
          completedBy: "Expo"
        }
      ]
    });

    expect(ticket.provider).toBe("deliverect");
    expect(ticket.sourceOrderId).toBe("deliv-order-1");
    expect(ticket.items[0]).toMatchObject({
      providerLineItemId: "provider-line-1",
      itemKey: "provider-line-1",
      completed: true,
      completedBy: "Expo"
    });
  });

  it("parses Deliverect provider settings and item action defaults", () => {
    const provider = DeliverectProviderSettingsSchema.parse({
      enabled: true,
      environment: "production",
      externalLocationId: "external-1",
      locationId: "location-1",
      channelLinkId: "channel-1",
      apiToken: "token-1",
      hmacSecret: "secret-1",
      registerWebhookStatus: null,
      ordersWebhookStatus: null,
      lastRegisterWebhookAt: null,
      lastOrderWebhookAt: null
    });
    const itemAction = TicketItemActionRequestSchema.parse({
      action: "complete"
    });

    expect(provider.environment).toBe("production");
    expect(itemAction).toEqual({
      action: "complete",
      actor: "Kitchen"
    });
  });

  it("parses optional realtime trace metadata and receipt reports", () => {
    const event = RealtimeEventSchema.parse({
      id: "event-1",
      type: "ticket.created",
      merchantId: "merchant-1",
      occurredAt: "2026-04-24T12:00:00.000Z",
      publishedAt: "2026-04-24T12:00:00.250Z",
      seq: 5,
      trace: {
        providerEventId: "provider-event-1",
        webhookReceivedAt: "2026-04-24T11:59:59.900Z",
        realtimePublishedAt: "2026-04-24T12:00:00.250Z"
      },
      ticket: {
        id: "ticket-1",
        merchantId: "merchant-1",
        provider: "clover",
        cloverOrderId: "order-1",
        sourceOrderId: "order-1",
        orderLabel: "#1001",
        status: "new",
        priority: 0,
        source: "Clover",
        orderType: "Dine In",
        paymentState: null,
        note: null,
        lastActor: null,
        heldAt: null,
        holdUntil: null,
        displayChannelLabel: null,
        displayFulfillmentTimeLabel: null,
        hasLocalEdits: false,
        createdAt: "2026-04-24T12:00:00.000Z",
        updatedAt: "2026-04-24T12:00:00.000Z",
        elapsedMinutes: 0,
        items: []
      }
    });
    const receipt = RealtimeReceiptRequestSchema.parse({
      eventId: "event-1",
      merchantId: "merchant-1",
      ticketId: "ticket-1",
      browserReceivedAt: "2026-04-24T12:00:00.300Z",
      renderCommittedAt: "2026-04-24T12:00:00.350Z"
    });

    expect(event.trace?.providerEventId).toBe("provider-event-1");
    expect(receipt.renderCommittedAt).toBe("2026-04-24T12:00:00.350Z");
  });
});
