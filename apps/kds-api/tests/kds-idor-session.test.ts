import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDeviceToken, resolveKdsRequestMerchant } from "../src/lib/kds-auth.js";
import { registerKdsRoutes } from "../src/routes/kds.js";
import type { AppServices } from "../src/lib/services.js";

// ---------------------------------------------------------------------------
// Non-vacuous IDOR regression test (audit-2026-06-03 #470/#471/#472/#473).
//
// The prior fix added a per-mutator ownership guard but the *resolution* of the
// request's merchant still echoed the client's ?merchantId= for session callers
// (Session = { accountId }, no merchant scope). So a session could pass
// ?merchantId=<victim> → the resolved store became the victim's → the guard's
// `ticket.merchantId === resolvedMerchant` check PASSED → the cascade DELETE ran.
//
// This test boots the REAL security path — the same `resolveKdsRequestMerchant`
// the app preHandler runs — in front of the REAL kds routes, with a genuine
// (mocked) web SESSION. It then performs the exact attack:
//
//     DELETE /api/kds/tickets/<ticket-owned-by-M2>?merchantId=M2   (session)
//
// With the vulnerable code this returns 200 and deletes M2's ticket + order.
// With the fix the session is pinned to its authorized store (M1), the M2
// ticket fails the ownership guard, and it is denied 403 with NO $transaction.
// ---------------------------------------------------------------------------

const SESSION_COOKIE = "yr_web_session";
const SESSION_ID = "session-acct-1";
const AUTHORIZED_MERCHANT = "M1"; // the merchant the session's account is authorized for
const VICTIM_MERCHANT = "M2"; // a DIFFERENT store the attacker tries to reach

const ATTACKER_ORIGIN = { origin: "https://kds.example.com" }; // trusted, so the
// session write-origin (CSRF) check passes and we isolate the IDOR behavior.

type DeviceMock = { token: string; tokenHash: string; merchantId: string };

function makeServices(options: { device?: DeviceMock } = {}) {
  const transaction = vi.fn(async () => undefined);
  const publishSnapshotRequired = vi.fn(async () => undefined);
  const ticketUpdate = vi.fn();
  const overrideUpsert = vi.fn();
  const overrideDeleteMany = vi.fn();
  const ticketEventCreate = vi.fn();
  const hubPublish = vi.fn();

  // A ticket that belongs to the VICTIM store. findUnique resolves by id only
  // (the IDOR shape): an attacker who guesses the id gets the row back.
  const victimTicket = {
    id: "victim-ticket",
    merchantId: VICTIM_MERCHANT,
    cloverOrderId: "victim-order",
    sourceOrderId: "victim-order",
    orderLabel: "Victim",
    status: "NEW",
    searchText: "victim",
    source: "Pickup",
    orderType: "Pickup",
    note: null,
    items: [{ itemKey: "line-1", name: "Roll", quantity: 1, refunded: false, completed: false }],
    localEdit: null,
    order: null
  };
  // A ticket that belongs to the SESSION's own authorized store (positive control).
  const ownTicket = { ...victimTicket, id: "own-ticket", merchantId: AUTHORIZED_MERCHANT, cloverOrderId: "own-order" };

  const findUnique = vi.fn(async ({ where }: { where: { id: string } }) => {
    if (where.id === victimTicket.id) return victimTicket;
    if (where.id === ownTicket.id) return ownTicket;
    return null;
  });

  const services = {
    config: {
      appBaseUrl: "https://kds.example.com",
      cloverBaseUrl: "https://api.clover.com",
      cloverRegion: "US",
      // Configured default merchant = the single authorized store (single-merchant
      // prod, ADR-0018). resolveDefaultCloverMerchantId returns this for a session.
      cloverMerchantId: AUTHORIZED_MERCHANT,
      cloverToken: "tok"
    },
    auth: {
      // A valid session keyed by the cookie. No merchant scope — Session = { accountId }.
      readSession: vi.fn(async (id: string) => (id === SESSION_ID ? { accountId: "acct-1" } : null)),
      getAccountById: vi.fn(async (accountId: string) => (accountId === "acct-1" ? { id: "acct-1" } : null))
    },
    prisma: {
      providerAppState: { findUnique: vi.fn(async () => null) },
      cloverMerchant: { findUnique: vi.fn(async () => null), findFirst: vi.fn(async () => null) },
      kdsDeviceToken: {
        findFirst: vi.fn(async ({ where }: { where: { tokenHash: string } }) =>
          options.device && where.tokenHash === options.device.tokenHash
            ? { id: "device-1", merchantId: options.device.merchantId }
            : null
        ),
        update: vi.fn(async () => undefined)
      },
      kdsTicket: { findUnique, update: ticketUpdate },
      kdsTicketOverride: { upsert: overrideUpsert, deleteMany: overrideDeleteMany, delete: vi.fn() },
      kdsTicketEvent: { create: ticketEventCreate },
      kdsFilter: { findUnique: vi.fn(async () => null) },
      $transaction: transaction
    },
    hub: { publishSnapshotRequired, publish: hubPublish, currentSeq: vi.fn(async () => 0) }
  } as unknown as AppServices;

  return {
    services,
    ticket: { victim: victimTicket, own: ownTicket },
    spies: { transaction, publishSnapshotRequired, ticketUpdate, overrideUpsert, overrideDeleteMany, ticketEventCreate, hubPublish }
  };
}

// Build the app exactly like production for /api/kds/*: cookie parsing + the
// SAME merchant-resolution preHandler (resolveKdsRequestMerchant) + the real
// routes. This is what makes the test non-vacuous — the route is NOT registered
// standalone; the security path runs.
async function buildApp(services: AppServices) {
  const app = Fastify();
  await app.register(cookie);

  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api/kds/")) return;
    const resolved = await resolveKdsRequestMerchant(services, request, reply);
    if (resolved.rejected) {
      reply.send({ error: reply.statusCode === 403 ? "Forbidden" : "Unauthorized" });
      return reply;
    }
    request.kdsMerchantId = resolved.merchantId;
  });

  await registerKdsRoutes(app as never, services);
  return app;
}

function sessionHeaders() {
  return { cookie: `${SESSION_COOKIE}=${SESSION_ID}`, ...ATTACKER_ORIGIN };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("KDS ticket IDOR — a session cannot reach another merchant by passing ?merchantId= (audit-2026-06-03)", () => {
  it("DELETE: session?merchantId=<victim> on the victim's ticket is 403 and never runs the destructive $transaction (#472)", async () => {
    const { services, spies } = makeServices();
    const app = await buildApp(services);
    try {
      const res = await app.inject({
        method: "DELETE",
        url: `/api/kds/tickets/victim-ticket?merchantId=${VICTIM_MERCHANT}`,
        headers: sessionHeaders()
      });

      expect(res.statusCode).toBe(403);
      // 403 specifically from the ownership guard (not a CSRF/auth 403): the
      // session resolved to its own store M1, so the M2 ticket is forbidden.
      expect(res.json()).toEqual({ error: "Ticket does not belong to this merchant." });
      // The cascade delete (kdsTicket + cloverOrder) must NOT have run.
      expect(spies.transaction).not.toHaveBeenCalled();
      expect(spies.publishSnapshotRequired).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("POST action: session?merchantId=<victim> bumping the victim's ticket is 403 and never writes (#470)", async () => {
    const { services, spies } = makeServices();
    const app = await buildApp(services);
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/kds/tickets/victim-ticket/actions?merchantId=${VICTIM_MERCHANT}`,
        headers: sessionHeaders(),
        payload: { action: "bump", actor: "attacker" }
      });

      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: "Ticket does not belong to this merchant." });
      expect(spies.transaction).not.toHaveBeenCalled();
      expect(spies.ticketUpdate).not.toHaveBeenCalled();
      expect(spies.hubPublish).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("PUT local-edit: session?merchantId=<victim> tampering the victim's ticket is 403 and never writes (#471)", async () => {
    const { services, spies } = makeServices();
    const app = await buildApp(services);
    try {
      const res = await app.inject({
        method: "PUT",
        url: `/api/kds/tickets/victim-ticket/local-edit?merchantId=${VICTIM_MERCHANT}`,
        headers: sessionHeaders(),
        payload: { orderLabel: "pwned", channelLabel: "", fulfillmentTimeLabel: "", note: "tampered" }
      });

      expect(res.statusCode).toBe(403);
      expect(spies.transaction).not.toHaveBeenCalled();
      expect(spies.overrideUpsert).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("POST item action: session?merchantId=<victim> completing the victim's item is 403 and never writes (#473)", async () => {
    const { services, spies } = makeServices();
    const app = await buildApp(services);
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/kds/tickets/victim-ticket/items/line-1/actions?merchantId=${VICTIM_MERCHANT}`,
        headers: sessionHeaders(),
        payload: { action: "complete", actor: "attacker" }
      });

      expect(res.statusCode).toBe(403);
      expect(spies.transaction).not.toHaveBeenCalled();
      expect(spies.ticketUpdate).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("POSITIVE CONTROL: a session deleting ITS OWN store's ticket still succeeds (the fix does not break legit writes)", async () => {
    const { services, spies } = makeServices();
    const app = await buildApp(services);
    try {
      // No ?merchantId needed; the session is pinned to its authorized store M1,
      // which owns own-ticket. The delete must proceed to the $transaction.
      const res = await app.inject({
        method: "DELETE",
        url: "/api/kds/tickets/own-ticket",
        headers: sessionHeaders()
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, merchantId: AUTHORIZED_MERCHANT, ticketId: "own-ticket" });
      expect(spies.transaction).toHaveBeenCalledTimes(1);
      expect(spies.publishSnapshotRequired).toHaveBeenCalledWith(AUTHORIZED_MERCHANT, "ticket-deleted");
    } finally {
      await app.close();
    }
  });

  it("POSITIVE CONTROL: even if a session passes ?merchantId=M1 (its own store), the delete of its own ticket still works", async () => {
    const { services, spies } = makeServices();
    const app = await buildApp(services);
    try {
      const res = await app.inject({
        method: "DELETE",
        url: `/api/kds/tickets/own-ticket?merchantId=${AUTHORIZED_MERCHANT}`,
        headers: sessionHeaders()
      });

      expect(res.statusCode).toBe(200);
      expect(spies.transaction).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});

describe("KDS ticket IDOR — device flows are unaffected by the session pinning", () => {
  it("a device bound to the victim store CAN delete its own ticket (device binding preserved)", async () => {
    const device = createDeviceToken();
    const { services, spies } = makeServices({ device: { ...device, merchantId: VICTIM_MERCHANT } });
    const app = await buildApp(services);
    try {
      // Device token bound to M2 deleting M2's ticket: the bound store IS the
      // ticket's store, so it passes the ownership guard and proceeds.
      const res = await app.inject({
        method: "DELETE",
        url: "/api/kds/tickets/victim-ticket",
        headers: { authorization: `Bearer ${device.token}` }
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, merchantId: VICTIM_MERCHANT });
      expect(spies.transaction).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("a device bound to M1 passing ?merchantId=M2 is rejected 403 by ensureDeviceMerchantAccess (cannot escape its store)", async () => {
    const device = createDeviceToken();
    const { services, spies } = makeServices({ device: { ...device, merchantId: AUTHORIZED_MERCHANT } });
    const app = await buildApp(services);
    try {
      const res = await app.inject({
        method: "DELETE",
        url: `/api/kds/tickets/victim-ticket?merchantId=${VICTIM_MERCHANT}`,
        headers: { authorization: `Bearer ${device.token}` }
      });

      expect(res.statusCode).toBe(403);
      expect(spies.transaction).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
