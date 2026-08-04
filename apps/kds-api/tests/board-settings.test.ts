import { describe, expect, it } from "vitest";
import type { KdsFilter, KdsProviderConfig } from "@rop/db-kds";
import type { AppConfig } from "../src/config.js";
import {
  buildDeliverectProviderUpsert,
  defaultBoardSettings,
  formatDailyResetTime,
  parseDailyResetTime,
  resolveNightlyResetSettings,
  serializeBoardSettings,
  serializeStoredBoardSettings
} from "../src/lib/board-settings.js";

const config = {
  dailyResetEnabled: true,
  dailyResetHour: 21,
  dailyResetMinute: 0,
  dailyResetTimezone: "America/Chicago"
} as AppConfig;

describe("board settings helpers", () => {
  it("serializes defaults when no merchant settings or provider config are stored", () => {
    const result = serializeBoardSettings(null, null, config);

    expect(result).toEqual(defaultBoardSettings(config));
  });

  it("reads stored merchant preferences and Deliverect config ahead of env defaults", () => {
    const filter = {
      merchantId: "M1",
      allowedOrderTypes: [],
      blockedSources: [],
      paymentStates: [],
      createdAfterMinutes: null,
      searchText: "",
      includeCompleted: false,
      soundEnabled: false,
      screenPinEnabled: true,
      boardSettings: {
        boardTimeZone: "America/Denver",
        dailyResetEnabled: false,
        dailyResetTime: "18:45",
        urgencyWarningMinutes: 6,
        urgencyCriticalMinutes: 12,
        urgencyBlinkCritical: false,
        modifierDangerKeywords: ["allergy", "no onion"],
        modifierAccentKeywords: ["extra sauce"],
        display: {
          weather: {
            enabled: true,
            zipCode: "38134",
            countryCode: "us",
            unit: "fahrenheit"
          }
        }
      }
    } satisfies Partial<KdsFilter>;
    const provider = {
      enabled: true,
      environment: "PRODUCTION",
      externalLocationId: "external-1",
      providerLocationId: "location-1",
      channelLinkId: "channel-1",
      apiToken: "token-1",
      hmacSecret: "secret-1",
      registerWebhookStatus: "registered",
      ordersWebhookStatus: "healthy",
      lastRegisterWebhookAt: new Date("2026-04-21T18:45:00.000Z"),
      lastOrderWebhookAt: new Date("2026-04-21T19:00:00.000Z")
    } satisfies Partial<KdsProviderConfig>;

    const result = serializeBoardSettings(filter as KdsFilter, provider as KdsProviderConfig, config);

    expect(result).toMatchObject({
      boardTimeZone: "America/Denver",
      dailyResetEnabled: false,
      dailyResetTime: "18:45",
      urgencyWarningMinutes: 6,
      urgencyCriticalMinutes: 12,
      urgencyBlinkCritical: false,
      modifierDangerKeywords: ["allergy", "no onion"],
      modifierAccentKeywords: ["extra sauce"],
      display: {
        weather: {
          enabled: true,
          zipCode: "38134",
          countryCode: "US",
          unit: "fahrenheit"
        }
      },
      providers: {
        deliverect: {
          enabled: true,
          environment: "production",
          externalLocationId: "external-1",
          locationId: "location-1",
          channelLinkId: "channel-1",
          // Phase 4.5.3: apiToken / hmacSecret never leak in the serialized
          // payload, even when the row has a plaintext fallback (the
          // Backoffice editor reads through the dedicated
          // /api/admin/kds/integrations/deliverect masked endpoint instead).
          apiToken: "",
          hmacSecret: "",
          registerWebhookStatus: "registered",
          ordersWebhookStatus: "healthy",
          lastRegisterWebhookAt: "2026-04-21T18:45:00.000Z",
          lastOrderWebhookAt: "2026-04-21T19:00:00.000Z"
        }
      }
    });
    expect(result.filter.soundEnabled).toBe(false);
    expect(result.filter.screenPinEnabled).toBe(true);
  });

  it("never serializes decrypted Deliverect secrets, even when both plaintext and cipher rows are present", () => {
    const provider = {
      enabled: true,
      environment: "PRODUCTION",
      externalLocationId: "external-1",
      providerLocationId: "location-1",
      channelLinkId: "channel-1",
      apiToken: "plaintext-token-do-not-leak",
      hmacSecret: "plaintext-hmac-do-not-leak",
      apiTokenCipher: null,
      hmacSecretCipher: null,
      registerWebhookStatus: "registered",
      ordersWebhookStatus: "healthy",
      lastRegisterWebhookAt: null,
      lastOrderWebhookAt: null
    } satisfies Partial<KdsProviderConfig>;

    const result = serializeBoardSettings(null, provider as KdsProviderConfig, config);

    expect(result.providers.deliverect.apiToken).toBe("");
    expect(result.providers.deliverect.hmacSecret).toBe("");
    // Sanity: non-secret provider metadata still flows to the Floor so it can
    // render the "Connected to Deliverect" status badge.
    expect(result.providers.deliverect.enabled).toBe(true);
    expect(result.providers.deliverect.environment).toBe("production");
    expect(result.providers.deliverect.externalLocationId).toBe("external-1");
  });

  it("serializes stored board settings separately from Deliverect secrets", () => {
    const settings = {
      ...defaultBoardSettings(config),
      boardTimeZone: "America/Los_Angeles",
      dailyResetEnabled: false,
      dailyResetTime: "17:30",
      reconcileIntervalSeconds: 30,
      urgencyWarningMinutes: 8,
      urgencyCriticalMinutes: 16,
      urgencyBlinkCritical: false,
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
          enabled: true,
          environment: "production",
          externalLocationId: "external-9",
          locationId: "location-9",
          channelLinkId: "channel-9",
          apiToken: "api-token",
          hmacSecret: "hmac-secret",
          registerWebhookStatus: "registered",
          ordersWebhookStatus: "healthy",
          lastRegisterWebhookAt: "2026-04-21T17:30:00.000Z",
          lastOrderWebhookAt: "2026-04-21T17:45:00.000Z"
        }
      }
    };

    expect(serializeStoredBoardSettings(settings)).toEqual({
      boardTimeZone: "America/Los_Angeles",
      dailyResetEnabled: false,
      dailyResetTime: "17:30",
      reconcileIntervalSeconds: 30,
      urgencyWarningMinutes: 8,
      urgencyCriticalMinutes: 16,
      urgencyBlinkCritical: false,
      modifierDangerKeywords: ["allergy"],
      modifierAccentKeywords: ["extra"],
      display: {
        weather: {
          enabled: true,
          zipCode: "00000",
          countryCode: "US",
          unit: "fahrenheit"
        }
      }
    });
  });

  it("builds a Deliverect provider upsert payload from board settings", () => {
    const settings = {
      ...defaultBoardSettings(config),
      providers: {
        deliverect: {
          enabled: true,
          environment: "production",
          externalLocationId: "external-2",
          locationId: "location-2",
          channelLinkId: "channel-2",
          apiToken: "token-2",
          hmacSecret: "secret-2",
          registerWebhookStatus: "registered",
          ordersWebhookStatus: "degraded",
          lastRegisterWebhookAt: "2026-04-21T20:00:00.000Z",
          lastOrderWebhookAt: "2026-04-21T20:15:00.000Z"
        }
      }
    };

    const result = buildDeliverectProviderUpsert(settings);

    expect(result).toMatchObject({
      enabled: true,
      environment: "PRODUCTION",
      externalLocationId: "external-2",
      providerLocationId: "location-2",
      channelLinkId: "channel-2",
      apiToken: "token-2",
      hmacSecret: "secret-2",
      registerWebhookStatus: "registered",
      ordersWebhookStatus: "degraded"
    });
    expect(result.lastRegisterWebhookAt?.toISOString()).toBe("2026-04-21T20:00:00.000Z");
    expect(result.lastOrderWebhookAt?.toISOString()).toBe("2026-04-21T20:15:00.000Z");
  });

  it("parses reset times for the nightly reset job", () => {
    expect(formatDailyResetTime(9, 5)).toBe("09:05");
    expect(parseDailyResetTime("18:45")).toEqual({ hour: 18, minute: 45 });

    const reset = resolveNightlyResetSettings(
      {
        boardSettings: {
          boardTimeZone: "America/New_York",
          dailyResetEnabled: true,
          dailyResetTime: "20:30"
        }
      } as KdsFilter,
      config
    );

    expect(reset).toEqual({
      enabled: true,
      timeZone: "America/New_York",
      hour: 20,
      minute: 30
    });
  });
});
