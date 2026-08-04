import type { AppServices } from "./services.js";
import { assertTicketOwnership } from "./ticket-access.js";

export type LocalTicketDeleteResult = {
  ok: true;
  merchantId: string;
  orderId: string;
  ticketId: string;
};

export async function deleteLocalTicket(
  services: AppServices,
  merchantId: string,
  ticketId: string
): Promise<LocalTicketDeleteResult> {
  const found = await services.prisma.kdsTicket.findUnique({
    where: { id: ticketId },
    select: {
      id: true,
      merchantId: true,
      cloverOrderId: true
    }
  });

  // Highest blast radius: this deletes the kdsTicket AND its cloverOrder (FK
  // cascade), permanently. Reject before any delete so one store can never drop
  // another store's order history (audit-2026-06-03 #472). A missing ticket is a
  // 404 (the route previously surfaced this as such); a cross-merchant id is 403.
  const ticket = assertTicketOwnership(found, merchantId);

  await services.prisma.$transaction(async (tx) => {
    await tx.cloverOrder.delete({
      where: {
        id: ticket.cloverOrderId
      }
    });
  });

  return {
    ok: true,
    merchantId: ticket.merchantId,
    orderId: ticket.cloverOrderId,
    ticketId: ticket.id
  };
}
