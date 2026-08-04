import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Regression coverage for the `POST /api/order` BFF input guard.
 *
 * The route maps the dollars cart to integer cents via `dollarsToCents`, which
 * throws a RangeError on any non-finite input. Before the schema guard, a line
 * with a non-numeric `unitPrice` (or a modifier with a non-numeric
 * `priceDelta`) reached that map and surfaced as a 500. These tests assert it
 * is now a clean 400 — and that a valid cart still forwards to kds-api.
 */

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function loadPost() {
  const mod = await import("@/app/api/order/route");
  return mod.POST;
}

function postRequest(body: unknown): Request {
  return new Request("http://localhost:3004/api/order", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const validLine = {
  lineId: "l1",
  itemId: "i1",
  itemName: "Strawberry Roll",
  unitPrice: 7.99,
  quantity: 1,
  modifiers: [{ id: "m1", name: "Oreo crumble", priceDelta: 0.5 }],
};

describe("POST /api/order — input validation", () => {
  test("non-numeric line unitPrice returns 400, not 500, and never calls upstream", async () => {
    // The exact stale-localStorage / tampered-client case: a string where a
    // number is expected. dollarsToCents("abc") would have thrown a RangeError.
    const cart = {
      customerName: "Sam",
      lines: [{ ...validLine, unitPrice: "abc" }],
    };

    const POST = await loadPost();
    const res = await POST(postRequest(cart));

    expect(res.status).toBe(400);
    expect(res.status).not.toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toEqual({ error: "Invalid order." });
  });

  test("non-finite modifier priceDelta returns 400", async () => {
    const cart = {
      customerName: "Sam",
      lines: [{ ...validLine, modifiers: [{ id: "m1", name: "x", priceDelta: null }] }],
    };

    const POST = await loadPost();
    const res = await POST(postRequest(cart));

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("empty cart returns 400", async () => {
    const POST = await loadPost();
    const res = await POST(postRequest({ customerName: "Sam", lines: [] }));

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("malformed JSON returns 400", async () => {
    const POST = await loadPost();
    const req = new Request("http://localhost:3004/api/order", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a valid cart is priced and forwarded to kds-api (200)", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          orderId: "o1",
          ticketNumber: "R-001",
          totals: { subtotalCents: 799, taxCents: 70, totalCents: 869 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const POST = await loadPost();
    const res = await POST(postRequest({ customerName: "Sam", lines: [validLine] }));

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The advisory dollars were converted to integer cents on the wire.
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const forwardedBody = JSON.parse((init as { body: string }).body);
    expect(forwardedBody.lines[0].unitPriceCents).toBe(799);
    expect(forwardedBody.lines[0].modifiers[0].priceDeltaCents).toBe(50);
  });

  test("string semantics are kds-api's job: a long, untrimmed customerName is forwarded verbatim, not gatekept", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          orderId: "o1",
          ticketNumber: "R-001",
          totals: { subtotalCents: 799, taxCents: 70, totalCents: 869 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    // kds-api caps customerName at 120 and trims it; the BFF intentionally does
    // neither — it only guarantees a present string and forwards it verbatim,
    // leaving length/trim to the single source of truth (no drift).
    const padded = `  ${"x".repeat(500)}  `;

    const POST = await loadPost();
    const res = await POST(postRequest({ customerName: padded, lines: [validLine] }));

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const forwarded = JSON.parse((init as { body: string }).body);
    expect(forwarded.customerName).toBe(padded);
  });
});
