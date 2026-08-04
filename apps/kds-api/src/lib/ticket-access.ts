/**
 * Merchant-ownership guard for KDS ticket mutators.
 *
 * Every ticket-action / local-edit / DELETE / item-action path resolves a
 * ticket by id and then mutates (or deletes order records). Without checking
 * that the ticket belongs to the *authenticated* store, an authenticated caller
 * for merchant A could read/edit/DELETE merchant B's tickets and order rows by
 * guessing an id — a cross-merchant IDOR (audit-2026-06-03 #470/#471/#472/#473).
 *
 * The mutators thread in the merchant the request resolved to
 * (`request.kdsMerchantId`, set by the app-level auth preHandler; device tokens
 * are store-bound per ADR-0018 Phase 5) and call `assertTicketOwnership` right
 * after the lookup, before any write. A missing ticket is a 404; a ticket owned
 * by another merchant is a 403 — and, crucially, indistinguishable enough that
 * we never leak whether some other store's id exists.
 */
export class TicketAccessError extends Error {
  readonly statusCode: 403 | 404;

  constructor(statusCode: 403 | 404, message: string) {
    super(message);
    this.name = "TicketAccessError";
    this.statusCode = statusCode;
  }
}

/**
 * Guard a ticket lookup against the authenticated merchant.
 *
 * @param ticket the row returned from `kdsTicket.findUnique` (or `null`)
 * @param merchantId the store the request is authorized for (request.kdsMerchantId)
 * @throws {TicketAccessError} 404 when the ticket does not exist; 403 when it
 *         belongs to a different merchant.
 * @returns the same ticket, now narrowed to non-null, for ergonomic chaining.
 */
export function assertTicketOwnership<T extends { merchantId: string }>(
  ticket: T | null,
  merchantId: string
): T {
  if (!ticket) {
    throw new TicketAccessError(404, "Ticket not found.");
  }
  if (ticket.merchantId !== merchantId) {
    // Treat a cross-merchant id as Forbidden. Do not reveal that the id maps to
    // a real ticket under another store.
    throw new TicketAccessError(403, "Ticket does not belong to this merchant.");
  }
  return ticket;
}
