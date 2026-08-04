import type { NormalizedOrder } from "@rop/contracts";
import { KdsTicketStatus } from "@rop/db-kds";
import type { AppServices } from "./services.js";
import { syncNormalizedOrder } from "./sync-order.js";

function demoOrder(
  merchantId: string,
  key: string,
  orderLabel: string,
  source: string,
  items: NormalizedOrder["items"],
  note?: string | null
): NormalizedOrder {
  const createdAt = new Date().toISOString();

  return {
    provider: "demo",
    merchantId,
    orderId: `demo:${key}`,
    sourceOrderId: key,
    orderLabel,
    source,
    orderType: source.includes("Delivery") ? "Delivery" : "Pickup",
    paymentState: "PAID",
    note: note ?? null,
    priority: 1,
    createdAt,
    modifiedAt: createdAt,
    items,
    amounts: null,
    customer: null
  };
}

export async function seedDemoOrders(services: AppServices, merchantId: string) {
  const demoOrders: NormalizedOrder[] = [
    demoOrder(
      merchantId,
      "deliverect-uber-1",
      "UE-1042",
      "Uber Eats via Deliverect",
      [
        {
          cloverLineItemId: null,
          providerLineItemId: "ue-burger-1",
          itemKey: "ue-burger-1",
          itemId: "burger-1",
          name: "BBQ Bacon Burger",
          alternateName: null,
          note: "No tomato",
          modifiers: ["No tomato", "Extra Cheese"],
          quantity: 1,
          priceCents: null,
          refunded: false,
          printed: false
        },
        {
          cloverLineItemId: null,
          providerLineItemId: "ue-fries-1",
          itemKey: "ue-fries-1",
          itemId: "fries-1",
          name: "Fries",
          alternateName: null,
          note: "Extra crispy",
          modifiers: [],
          quantity: 1,
          priceCents: null,
          refunded: false,
          printed: false
        }
      ],
      "Demo Deliverect aggregator order"
    ),
    demoOrder(
      merchantId,
      "deliverect-doordash-1",
      "DD-2058",
      "DoorDash via Deliverect",
      [
        {
          cloverLineItemId: null,
          providerLineItemId: "dd-wrap-1",
          itemKey: "dd-wrap-1",
          itemId: "wrap-1",
          name: "Chicken Caesar Wrap",
          alternateName: null,
          note: null,
          modifiers: ["No onions"],
          quantity: 1,
          priceCents: null,
          refunded: false,
          printed: false
        },
        {
          cloverLineItemId: null,
          providerLineItemId: "dd-salad-1",
          itemKey: "dd-salad-1",
          itemId: "salad-1",
          name: "Caesar Salad",
          alternateName: null,
          note: null,
          modifiers: ["Add avocado"],
          quantity: 1,
          priceCents: null,
          refunded: false,
          printed: false
        }
      ]
    ),
    demoOrder(
      merchantId,
      "deliverect-pickup-1",
      "Pickup 12:30 PM",
      "Pickup via Deliverect",
      [
        {
          cloverLineItemId: null,
          providerLineItemId: "pickup-taco-1",
          itemKey: "pickup-taco-1",
          itemId: "taco-1",
          name: "Carne Asada Taco",
          alternateName: null,
          note: null,
          modifiers: ["Gluten-free", "On side salsa"],
          quantity: 2,
          priceCents: null,
          refunded: false,
          printed: false
        }
      ]
    )
  ];

  const created = [];
  for (const order of demoOrders) {
    const event = await syncNormalizedOrder(services, order, {
      id: order.sourceOrderId,
      channelOrderId: order.orderLabel,
      source: order.source,
      note: order.note,
      items: order.items
    }, "manual", "Demo seed");
    created.push(event);
  }

  const statusTargets = await services.prisma.kdsTicket.findMany({
    where: {
      merchantId,
      provider: "DEMO",
      sourceOrderId: {
        in: demoOrders.map((order) => order.sourceOrderId)
      }
    }
  });

  for (const ticket of statusTargets) {
    const nextStatus = ticket.sourceOrderId === "deliverect-uber-1"
      ? KdsTicketStatus.IN_PROGRESS
      : ticket.sourceOrderId === "deliverect-doordash-1"
        ? KdsTicketStatus.READY
        : KdsTicketStatus.NEW;

    if (ticket.status !== nextStatus) {
      await services.prisma.kdsTicket.update({
        where: { id: ticket.id },
        data: {
          status: nextStatus
        }
      });
    }
  }

  return created;
}
