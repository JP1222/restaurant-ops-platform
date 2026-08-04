import { afterEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/order/checkout/route";

/**
 * BFF inbound-validation tests for POST /api/order/checkout.
 *
 * The regression guarded here: a truthy non-number `tip` used to reach
 * `dollarsToCents` (which throws RangeError on a non-finite value) OUTSIDE the
 * handler's try/catch, surfacing as an uncaught 500. After the safeParse guard
 * it must be a clean 400 — and a valid body must still forward (200) with the
 * dollars→cents conversion applied. Upstream `fetch` is stubbed so no real
 * kds-api call is made; the 400 paths assert it is never reached.
 */

function checkoutRequest(body: unknown): Request {
  return new Request("http://localhost/api/order/checkout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const validConfirmation = {
  orderId: "o1",
  ticketNumber: "R-042",
  state: "paid",
  totals: {
    subtotalCents: 899,
    taxCents: 88,
    tipCents: 500,
    totalCents: 1487,
    currency: "USD",
  },
  updatedAt: "2026-06-16T12:00:00.000Z",
};

function stubUpstreamOk() {
  const fetchMock = vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify(validConfirmation), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("POST /api/order/checkout — inbound validation", () => {
  it("returns 400 (not 500) for a non-numeric tip and never calls upstream", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(
      checkoutRequest({ orderId: "o1", paymentToken: "clv_t", tip: "abc" }),
    );

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // "5" and [] are JS-coercible (would silently become a tip today); {} and a
  // negative number are the crash / out-of-range cases. All must reject with 400.
  it.each([
    ["string number", "5"],
    ["object", {}],
    ["array", []],
    ["negative", -1],
  ])("returns 400 for a %s tip", async (_label, tip) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(checkoutRequest({ orderId: "o1", paymentToken: "clv_t", tip }));

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 400 for a missing paymentToken", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(checkoutRequest({ orderId: "o1" }));

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards a valid body, converting tip dollars → cents, and returns 200", async () => {
    const fetchMock = stubUpstreamOk();

    const res = await POST(
      checkoutRequest({ orderId: "o1", paymentToken: "clv_t", tip: 5 }),
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(init.body as string)).toMatchObject({
      orderId: "o1",
      paymentToken: "clv_t",
      tipCents: 500,
    });

    const json = (await res.json()) as { totals: { tip: number } };
    expect(json.totals.tip).toBe(5);
  });

  it("forwards tipCents 0 when no tip is provided", async () => {
    const fetchMock = stubUpstreamOk();

    const res = await POST(checkoutRequest({ orderId: "o1", paymentToken: "clv_t" }));

    expect(res.status).toBe(200);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(init.body as string).tipCents).toBe(0);
  });
});
