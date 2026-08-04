import {
  KitchenBoardDisplaySettingsSchema,
  DailyResetTimeSchema,
  type KitchenBoardSettings
} from "@rop/contracts";
import type { IntegrationEnvironment, KdsFilter, KdsProviderConfig } from "@rop/db-kds";
import type { AppConfig } from "../config.js";
import { decryptSecret } from "./crypto/encryption.js";
import { serializeFilter } from "./ticket-serializer.js";

type BoardSettingsHolder = Pick<KdsFilter, "boardSettings"> | null | undefined;
type DeliverectProviderHolder = KdsProviderConfig | null | undefined;
type DeliverectSecretSource =
  | Pick<KdsProviderConfig, "apiToken" | "hmacSecret" | "apiTokenCipher" | "hmacSecretCipher">
  | null
  | undefined;

function pad(value: number) {
  return String(value).padStart(2, "0");
}

// Keep in lockstep with `reconcileIntervalSeconds` in KitchenBoardSettingsSchema
// (packages/contracts). The reconciliation scheduler ticks at this floor, so the
// effective interval can never be set below it.
export const RECONCILE_INTERVAL_MIN_SECONDS = 3;
export const RECONCILE_INTERVAL_MAX_SECONDS = 300;

export function clampReconcileIntervalSeconds(value: number) {
  if (!Number.isFinite(value)) {
    return RECONCILE_INTERVAL_MIN_SECONDS;
  }
  return Math.min(
    RECONCILE_INTERVAL_MAX_SECONDS,
    Math.max(RECONCILE_INTERVAL_MIN_SECONDS, Math.trunc(value))
  );
}

function parseKeywordList(value: unknown, fallback: string[]) {
  if (!Array.isArray(value)) {
    return fallback;
  }

  const next = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return next.length > 0 ? next : fallback;
}

function parseStoredPreferences(filter: BoardSettingsHolder): Partial<KitchenBoardSettings> {
  const raw = filter?.boardSettings;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }

  const candidate = raw as Record<string, unknown>;
  const next: Partial<KitchenBoardSettings> = {};

  if (typeof candidate.boardTimeZone === "string" && candidate.boardTimeZone.trim()) {
    next.boardTimeZone = candidate.boardTimeZone.trim();
  }

  if (typeof candidate.dailyResetEnabled === "boolean") {
    next.dailyResetEnabled = candidate.dailyResetEnabled;
  }

  if (typeof candidate.dailyResetTime === "string") {
    const parsed = DailyResetTimeSchema.safeParse(candidate.dailyResetTime);
    if (parsed.success) {
      next.dailyResetTime = parsed.data;
    }
  }

  if (typeof candidate.urgencyWarningMinutes === "number" && Number.isFinite(candidate.urgencyWarningMinutes)) {
    next.urgencyWarningMinutes = Math.max(1, Math.trunc(candidate.urgencyWarningMinutes));
  }

  if (typeof candidate.urgencyCriticalMinutes === "number" && Number.isFinite(candidate.urgencyCriticalMinutes)) {
    next.urgencyCriticalMinutes = Math.max(1, Math.trunc(candidate.urgencyCriticalMinutes));
  }

  if (typeof candidate.urgencyBlinkCritical === "boolean") {
    next.urgencyBlinkCritical = candidate.urgencyBlinkCritical;
  }

  if (typeof candidate.reconcileIntervalSeconds === "number" && Number.isFinite(candidate.reconcileIntervalSeconds)) {
    next.reconcileIntervalSeconds = clampReconcileIntervalSeconds(candidate.reconcileIntervalSeconds);
  }

  next.modifierDangerKeywords = parseKeywordList(candidate.modifierDangerKeywords, defaultModifierDangerKeywords());
  next.modifierAccentKeywords = parseKeywordList(candidate.modifierAccentKeywords, defaultModifierAccentKeywords());
  next.display = parseStoredDisplaySettings(candidate.display);

  return next;
}

function defaultDisplaySettings(): KitchenBoardSettings["display"] {
  return KitchenBoardDisplaySettingsSchema.parse({});
}

function parseStoredDisplaySettings(value: unknown): KitchenBoardSettings["display"] {
  const parsed = KitchenBoardDisplaySettingsSchema.safeParse(value);
  if (!parsed.success) {
    return defaultDisplaySettings();
  }

  return {
    weather: {
      ...parsed.data.weather,
      countryCode: parsed.data.weather.countryCode.toUpperCase()
    }
  };
}

function environmentToContract(value: IntegrationEnvironment | null | undefined) {
  return value === "PRODUCTION" ? "production" : "staging";
}

function environmentToDb(value: KitchenBoardSettings["providers"]["deliverect"]["environment"]): IntegrationEnvironment {
  return value === "production" ? "PRODUCTION" : "STAGING";
}

/**
 * Resolves the Deliverect API token from the row, preferring the encrypted
 * cipher column when present and falling back to the plaintext column during
 * the Phase 4.5 rollout window. Returns null if no token has been configured.
 *
 * Phase 4.5.7 (queued for a future PR) drops the plaintext column once all
 * production rows have been migrated to ciphers.
 */
export function resolveDeliverectApiToken(provider: DeliverectSecretSource): string | null {
  if (provider?.apiTokenCipher) {
    return decryptSecret(Buffer.from(provider.apiTokenCipher));
  }
  return provider?.apiToken ?? null;
}

/** Same shape as resolveDeliverectApiToken, but for the webhook HMAC secret. */
export function resolveDeliverectHmacSecret(provider: DeliverectSecretSource): string | null {
  if (provider?.hmacSecretCipher) {
    return decryptSecret(Buffer.from(provider.hmacSecretCipher));
  }
  return provider?.hmacSecret ?? null;
}

/**
 * Serializes the Deliverect provider row into the cross-app
 * `KitchenBoardSettings` shape. As of Phase 4.5.3 (Iron Law #4 — Floor vs
 * Backoffice), this serializer NEVER includes the decrypted `apiToken` or
 * `hmacSecret` in its output. The fields are kept in the return type to
 * preserve backwards compatibility with the existing Floor client, but the
 * value is always an empty string — Floor staff (and anyone with read access
 * to the response body) sees only the non-secret metadata (enabled,
 * environment, location IDs, webhook health).
 *
 * The dedicated Backoffice editor calls
 * `GET /api/admin/kds/integrations/deliverect`, which returns last-4-only
 * masked tokens (`apiTokenMask: "••••<last4>"`). Plaintext secrets only ever
 * leave the database for outbound API calls (`deliverect-client.ts`
 * resolveDeliverectApiToken / resolveDeliverectHmacSecret) and webhook
 * signature validation — never in an HTTP response payload.
 */
function serializeDeliverectProvider(provider: DeliverectProviderHolder): KitchenBoardSettings["providers"]["deliverect"] {
  return {
    enabled: provider?.enabled ?? false,
    environment: environmentToContract(provider?.environment),
    externalLocationId: provider?.externalLocationId ?? "",
    locationId: provider?.providerLocationId ?? "",
    channelLinkId: provider?.channelLinkId ?? "",
    apiToken: "",
    hmacSecret: "",
    registerWebhookStatus: provider?.registerWebhookStatus ?? null,
    ordersWebhookStatus: provider?.ordersWebhookStatus ?? null,
    lastRegisterWebhookAt: provider?.lastRegisterWebhookAt?.toISOString() ?? null,
    lastOrderWebhookAt: provider?.lastOrderWebhookAt?.toISOString() ?? null
  };
}

export function defaultModifierDangerKeywords() {
  return ["no", "sin", "without", "allergy", "allergic", "gluten", "gluten-free"];
}

export function defaultModifierAccentKeywords() {
  return ["extra", "add", "on side", "sub"];
}

export function defaultBoardSettings(config: AppConfig): KitchenBoardSettings {
  return {
    filter: serializeFilter(null),
    boardTimeZone: config.dailyResetTimezone,
    dailyResetEnabled: config.dailyResetEnabled,
    dailyResetTime: formatDailyResetTime(config.dailyResetHour, config.dailyResetMinute),
    reconcileIntervalSeconds: clampReconcileIntervalSeconds(Math.round(config.reconcileIntervalMs / 1000)),
    urgencyWarningMinutes: 10,
    urgencyCriticalMinutes: 20,
    urgencyBlinkCritical: true,
    modifierDangerKeywords: defaultModifierDangerKeywords(),
    modifierAccentKeywords: defaultModifierAccentKeywords(),
    display: defaultDisplaySettings(),
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
}

export function formatDailyResetTime(hour: number, minute: number) {
  return `${pad(hour)}:${pad(minute)}`;
}

export function parseDailyResetTime(value: string) {
  const parsed = DailyResetTimeSchema.parse(value);
  const [hourText, minuteText] = parsed.split(":");

  return {
    hour: Number(hourText),
    minute: Number(minuteText)
  };
}

export function serializeBoardSettings(
  filter: KdsFilter | null | undefined,
  provider: DeliverectProviderHolder,
  config: AppConfig
): KitchenBoardSettings {
  const stored = parseStoredPreferences(filter);
  const defaults = defaultBoardSettings(config);

  return {
    filter: serializeFilter(filter),
    boardTimeZone: stored.boardTimeZone ?? defaults.boardTimeZone,
    dailyResetEnabled: stored.dailyResetEnabled ?? defaults.dailyResetEnabled,
    dailyResetTime: stored.dailyResetTime ?? defaults.dailyResetTime,
    reconcileIntervalSeconds: stored.reconcileIntervalSeconds ?? defaults.reconcileIntervalSeconds,
    urgencyWarningMinutes: stored.urgencyWarningMinutes ?? defaults.urgencyWarningMinutes,
    urgencyCriticalMinutes: stored.urgencyCriticalMinutes ?? defaults.urgencyCriticalMinutes,
    urgencyBlinkCritical: stored.urgencyBlinkCritical ?? defaults.urgencyBlinkCritical,
    modifierDangerKeywords: stored.modifierDangerKeywords ?? defaults.modifierDangerKeywords,
    modifierAccentKeywords: stored.modifierAccentKeywords ?? defaults.modifierAccentKeywords,
    display: stored.display ?? defaults.display,
    providers: {
      deliverect: serializeDeliverectProvider(provider)
    }
  };
}

export function serializeStoredBoardSettings(settings: KitchenBoardSettings) {
  return {
    boardTimeZone: settings.boardTimeZone,
    dailyResetEnabled: settings.dailyResetEnabled,
    dailyResetTime: settings.dailyResetTime,
    reconcileIntervalSeconds: settings.reconcileIntervalSeconds,
    urgencyWarningMinutes: settings.urgencyWarningMinutes,
    urgencyCriticalMinutes: settings.urgencyCriticalMinutes,
    urgencyBlinkCritical: settings.urgencyBlinkCritical,
    modifierDangerKeywords: settings.modifierDangerKeywords,
    modifierAccentKeywords: settings.modifierAccentKeywords,
    display: {
      weather: {
        ...settings.display.weather,
        countryCode: settings.display.weather.countryCode.toUpperCase()
      }
    }
  };
}

export function buildDeliverectProviderUpsert(settings: KitchenBoardSettings) {
  return {
    enabled: settings.providers.deliverect.enabled,
    environment: environmentToDb(settings.providers.deliverect.environment),
    externalLocationId: settings.providers.deliverect.externalLocationId || null,
    providerLocationId: settings.providers.deliverect.locationId || null,
    channelLinkId: settings.providers.deliverect.channelLinkId || null,
    apiToken: settings.providers.deliverect.apiToken || null,
    hmacSecret: settings.providers.deliverect.hmacSecret || null,
    registerWebhookStatus: settings.providers.deliverect.registerWebhookStatus,
    ordersWebhookStatus: settings.providers.deliverect.ordersWebhookStatus,
    lastRegisterWebhookAt: settings.providers.deliverect.lastRegisterWebhookAt ? new Date(settings.providers.deliverect.lastRegisterWebhookAt) : null,
    lastOrderWebhookAt: settings.providers.deliverect.lastOrderWebhookAt ? new Date(settings.providers.deliverect.lastOrderWebhookAt) : null
  };
}

export function resolveNightlyResetSettings(filter: BoardSettingsHolder, config: AppConfig) {
  const stored = parseStoredPreferences(filter);
  const timeZone = stored.boardTimeZone ?? config.dailyResetTimezone;
  const enabled = stored.dailyResetEnabled ?? config.dailyResetEnabled;
  const { hour, minute } = parseDailyResetTime(
    stored.dailyResetTime ?? formatDailyResetTime(config.dailyResetHour, config.dailyResetMinute)
  );

  return {
    enabled,
    timeZone,
    hour,
    minute
  };
}

/**
 * Resolves the effective reconciliation poll interval (ms) for a merchant,
 * preferring the operator-tuned board setting and falling back to the
 * RECONCILE_INTERVAL_MS env default. Read on every scheduler tick so a Backoffice
 * change takes effect without restarting kds-api.
 */
export function resolveReconcileIntervalMs(filter: BoardSettingsHolder, config: AppConfig) {
  const stored = parseStoredPreferences(filter);
  const seconds =
    stored.reconcileIntervalSeconds ??
    clampReconcileIntervalSeconds(Math.round(config.reconcileIntervalMs / 1000));
  return clampReconcileIntervalSeconds(seconds) * 1000;
}
