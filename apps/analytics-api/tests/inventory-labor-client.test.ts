import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import { fetchLaborCosts } from "../src/inventory/client.js";

const config = { inventoryApiBaseUrl: "http://inventory.internal" } as AppConfig;

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchLaborCosts", () => {
  it("parses labor-cost snapshots from inventory-api's /api/labor-costs", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        snapshots: [
          {
            merchant_id: "M1",
            daily_labor_cost_cents: 46666.67,
            currency: "USD",
            effective_from: "2026-06-01",
            note: "$2,800/wk / 6 days"
          }
        ]
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchLaborCosts(config);
    expect(res.snapshots).toHaveLength(1);
    expect(res.snapshots[0]?.merchant_id).toBe("M1");
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "http://inventory.internal/api/labor-costs"
    );
  });

  it("throws on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 502 })));
    await expect(fetchLaborCosts(config)).rejects.toThrow(/HTTP 502/);
  });

  it("rejects a payload that violates the shared contract", async () => {
    // Missing the required numeric fields -> zod parse throws at the trust boundary.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ snapshots: [{ merchant_id: "M1" }] })));
    await expect(fetchLaborCosts(config)).rejects.toThrow();
  });
});
