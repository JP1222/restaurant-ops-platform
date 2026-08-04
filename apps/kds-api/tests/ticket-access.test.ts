import { describe, expect, it, vi } from "vitest";

vi.mock("@rop/db-kds", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rop/db-kds")>();
  return {
    ...actual,
    OrderProvider: { CLOVER: "CLOVER", DELIVERECT: "DELIVERECT", DEMO: "DEMO" }
  };
});

import { assertTicketOwnership, TicketAccessError } from "../src/lib/ticket-access.js";
import { applyActionToTicket, applyActionToTicketItem } from "../src/lib/sync-order.js";
import { resetLocalEdit, saveLocalEdit } from "../src/lib/local-ticket-edit.js";
import { deleteLocalTicket } from "../src/lib/local-ticket-delete.js";
import type { AppServices } from "../src/lib/services.js";

const OWNER = "merchant-A";
const ATTACKER = "merchant-B";

function ticketOwnedBy(merchantId: string) {
  return {
    id: "ticket-1",
    merchantId,
    provider: "CLOVER",
    cloverOrderId: "order-1",
    sourceOrderId: "order-1",
    orderLabel: "Jordan",
    status: "NEW",
    priority: 0,
    lastActor: null,
    lastAction: null,
    searchText: "jordan",
    note: null,
    source: "Pickup",
    orderType: "Pickup",
    paymentState: "PAID",
    heldAt: null,
    holdUntil: null,
    acknowledgedAt: null,
    inProgressAt: null,
    readyAt: null,
    completedAt: null,
    bumpedAt: null,
    recalledAt: null,
    createdAt: new Date("2026-06-03T00:00:00.000Z"),
    updatedAt: new Date("2026-06-03T00:00:00.000Z"),
    items: [{ itemKey: "line-1", name: "Roll", quantity: 1, refunded: false, completed: false }],
    localEdit: { id: "edit-1", ticketId: "ticket-1", merchantId },
    order: null
  };
}

/**
 * Minimal services double. `findUnique` returns a ticket owned by `ownerMerchant`;
 * every mutating surface is a spy so a test can prove the guard short-circuits
 * BEFORE any write/transaction/fan-out runs.
 */
function makeServices(ownerMerchant: string) {
  const transaction = vi.fn();
  const cloverOrderDelete = vi.fn();
  const ticketUpdate = vi.fn();
  const overrideUpsert = vi.fn();
  const overrideDelete = vi.fn();
  const hubPublish = vi.fn();
  const hubPublishSnapshotRequired = vi.fn();

  const services = {
    prisma: {
      kdsTicket: {
        findUnique: vi.fn().mockResolvedValue(ticketOwnedBy(ownerMerchant)),
        update: ticketUpdate
      },
      cloverOrder: { delete: cloverOrderDelete },
      kdsTicketOverride: { upsert: overrideUpsert, delete: overrideDelete, deleteMany: vi.fn() },
      $transaction: transaction
    },
    hub: { publish: hubPublish, publishSnapshotRequired: hubPublishSnapshotRequired }
  } as unknown as AppServices;

  return {
    services,
    spies: { transaction, cloverOrderDelete, ticketUpdate, overrideUpsert, overrideDelete, hubPublish, hubPublishSnapshotRequired }
  };
}

function expectNoWrites(spies: ReturnType<typeof makeServices>["spies"]) {
  expect(spies.transaction).not.toHaveBeenCalled();
  expect(spies.cloverOrderDelete).not.toHaveBeenCalled();
  expect(spies.ticketUpdate).not.toHaveBeenCalled();
  expect(spies.overrideUpsert).not.toHaveBeenCalled();
  expect(spies.overrideDelete).not.toHaveBeenCalled();
  expect(spies.hubPublish).not.toHaveBeenCalled();
  expect(spies.hubPublishSnapshotRequired).not.toHaveBeenCalled();
}

describe("assertTicketOwnership", () => {
  it("returns the ticket when the merchant matches", () => {
    const ticket = { id: "t", merchantId: OWNER };
    expect(assertTicketOwnership(ticket, OWNER)).toBe(ticket);
  });

  it("throws 404 when the ticket is missing", () => {
    try {
      assertTicketOwnership(null, OWNER);
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(TicketAccessError);
      expect((error as TicketAccessError).statusCode).toBe(404);
    }
  });

  it("throws 403 (not 404) on a cross-merchant id so existence is not leaked", () => {
    try {
      assertTicketOwnership({ id: "t", merchantId: OWNER }, ATTACKER);
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(TicketAccessError);
      expect((error as TicketAccessError).statusCode).toBe(403);
    }
  });
});

describe("KDS ticket mutators deny cross-merchant ids (IDOR — audit-2026-06-03)", () => {
  it("applyActionToTicket: a merchant-B caller cannot bump merchant-A's ticket (#470)", async () => {
    const { services, spies } = makeServices(OWNER);
    await expect(
      applyActionToTicket(services, ATTACKER, "ticket-1", "bump", "attacker")
    ).rejects.toMatchObject({ statusCode: 403 });
    expectNoWrites(spies);
  });

  it("applyActionToTicketItem: a merchant-B caller cannot complete merchant-A's item (#473)", async () => {
    const { services, spies } = makeServices(OWNER);
    await expect(
      applyActionToTicketItem(services, ATTACKER, "ticket-1", "line-1", "complete", "attacker")
    ).rejects.toMatchObject({ statusCode: 403 });
    expectNoWrites(spies);
  });

  it("saveLocalEdit: a merchant-B caller cannot tamper merchant-A's ticket metadata (#471)", async () => {
    const { services, spies } = makeServices(OWNER);
    await expect(
      saveLocalEdit(services, ATTACKER, "ticket-1", {
        orderLabel: "pwned",
        channelLabel: "",
        fulfillmentTimeLabel: "",
        note: "tampered"
      })
    ).rejects.toMatchObject({ statusCode: 403 });
    expectNoWrites(spies);
  });

  it("resetLocalEdit: a merchant-B caller cannot clear merchant-A's override (#471)", async () => {
    const { services, spies } = makeServices(OWNER);
    await expect(
      resetLocalEdit(services, ATTACKER, "ticket-1")
    ).rejects.toMatchObject({ statusCode: 403 });
    expectNoWrites(spies);
  });

  it("deleteLocalTicket: a merchant-B caller cannot delete merchant-A's ticket + cloverOrder (#472)", async () => {
    const { services, spies } = makeServices(OWNER);
    await expect(
      deleteLocalTicket(services, ATTACKER, "ticket-1")
    ).rejects.toMatchObject({ statusCode: 403 });
    // The destructive cascade (kdsTicket + cloverOrder delete) must never run.
    expectNoWrites(spies);
  });

  it("deleteLocalTicket: an unknown ticket id is a 404, not a 403", async () => {
    const { services } = makeServices(OWNER);
    (services.prisma.kdsTicket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    await expect(
      deleteLocalTicket(services, OWNER, "missing")
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("the owning merchant is still allowed through the guard (delete proceeds to the transaction)", async () => {
    const { services, spies } = makeServices(OWNER);
    // Owner passes the guard; the delete reaches $transaction (which we stub to no-op).
    spies.transaction.mockResolvedValueOnce(undefined);
    const result = await deleteLocalTicket(services, OWNER, "ticket-1");
    expect(result).toMatchObject({ ok: true, merchantId: OWNER, ticketId: "ticket-1" });
    expect(spies.transaction).toHaveBeenCalledTimes(1);
  });
});
