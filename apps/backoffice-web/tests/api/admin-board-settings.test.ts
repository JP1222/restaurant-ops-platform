import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { KitchenBoardSettings } from "@rop/contracts";

const getBoardSettingsMock = vi.fn();
const updateBoardSettingsMock = vi.fn();

vi.mock("@/lib/kds-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/kds-api")>("@/lib/kds-api");
  return {
    ...actual,
    kdsApi: {
      getBoardSettings: (...args: unknown[]) => getBoardSettingsMock(...args),
      updateBoardSettings: (...args: unknown[]) => updateBoardSettingsMock(...args)
    }
  };
});

beforeEach(() => {
  getBoardSettingsMock.mockReset();
  updateBoardSettingsMock.mockReset();
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function callGet() {
  const { GET } = await import("@/app/api/admin/board-settings/route");
  const { NextRequest } = await import("next/server");
  return GET(new NextRequest("http://localhost:3001/api/admin/board-settings"));
}

async function callPut(body: unknown) {
  const { PUT } = await import("@/app/api/admin/board-settings/route");
  const { NextRequest } = await import("next/server");
  return PUT(
    new NextRequest("http://localhost:3001/api/admin/board-settings", {
      method: "PUT",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" }
    })
  );
}

const SAMPLE_SETTINGS: KitchenBoardSettings = {
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
  boardTimeZone: "America/Chicago",
  dailyResetEnabled: true,
  dailyResetTime: "21:00",
  reconcileIntervalSeconds: 45,
  urgencyWarningMinutes: 10,
  urgencyCriticalMinutes: 20,
  urgencyBlinkCritical: true,
  modifierDangerKeywords: ["allergy"],
  modifierAccentKeywords: ["extra"],
  display: {
    weather: {
      enabled: true,
      zipCode: "00000",
      countryCode: "US",
      unit: "fahrenheit"
    }
  },
  providers: {
    deliverect: {
      enabled: false,
      environment: "staging",
      externalLocationId: "",
      locationId: "",
      channelLinkId: "",
      apiToken: "",
      hmacSecret: "",
      registerWebhookStatus: null,
      ordersWebhookStatus: null,
      lastRegisterWebhookAt: null,
      lastOrderWebhookAt: null
    }
  }
};

describe("GET /api/admin/board-settings", () => {
  test("forwards the upstream response verbatim", async () => {
    getBoardSettingsMock.mockResolvedValueOnce({ merchantId: "m-1", settings: SAMPLE_SETTINGS });
    const response = await callGet();
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      merchantId: string;
      settings: KitchenBoardSettings;
    };
    expect(payload.merchantId).toBe("m-1");
    expect(payload.settings.display.weather).toEqual({
      enabled: true,
      zipCode: "00000",
      countryCode: "US",
      unit: "fahrenheit"
    });
  });
});

describe("PUT /api/admin/board-settings", () => {
  test("round-trips a weather widget update through the upstream call", async () => {
    const next: KitchenBoardSettings = {
      ...SAMPLE_SETTINGS,
      display: {
        weather: {
          enabled: false,
          zipCode: "10001",
          countryCode: "US",
          unit: "celsius"
        }
      }
    };
    updateBoardSettingsMock.mockResolvedValueOnce({ merchantId: "m-1", settings: next });

    const response = await callPut(next);
    expect(response.status).toBe(200);

    const upstreamCall = updateBoardSettingsMock.mock.calls[0]?.[0] as KitchenBoardSettings;
    expect(upstreamCall.display.weather).toEqual({
      enabled: false,
      zipCode: "10001",
      countryCode: "US",
      unit: "celsius"
    });

    const payload = (await response.json()) as {
      settings: KitchenBoardSettings;
    };
    expect(payload.settings.display.weather.zipCode).toBe("10001");
    expect(payload.settings.display.weather.unit).toBe("celsius");
  });

  test("rejects an invalid weather payload (bad zip pattern)", async () => {
    const bad = {
      ...SAMPLE_SETTINGS,
      display: {
        weather: {
          enabled: true,
          zipCode: "not-a-zip",
          countryCode: "US",
          unit: "fahrenheit"
        }
      }
    };
    const response = await callPut(bad);
    expect(response.status).toBe(400);
    expect(updateBoardSettingsMock).not.toHaveBeenCalled();
  });

  test("rejects an invalid country code (more than two letters)", async () => {
    const bad = {
      ...SAMPLE_SETTINGS,
      display: {
        weather: {
          enabled: true,
          zipCode: "00000",
          countryCode: "USA",
          unit: "fahrenheit"
        }
      }
    };
    const response = await callPut(bad);
    expect(response.status).toBe(400);
    expect(updateBoardSettingsMock).not.toHaveBeenCalled();
  });
});
