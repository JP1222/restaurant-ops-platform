import type { IntegrationEnvironment } from "@rop/db-kds";
import type { AppConfig } from "../config.js";

export const CLOVER_ADMIN_PATH = "/admin/integrations/clover";

export type CloverEnvReadinessItem = {
  name: string;
  ready: boolean;
  detail: string;
};

export function normalizeReturnToPath(value: string | undefined) {
  if (!value) {
    return CLOVER_ADMIN_PATH;
  }

  if (!value.startsWith("/") || value.startsWith("//")) {
    return CLOVER_ADMIN_PATH;
  }

  return value;
}

export function resolveCloverEnvironment(config: AppConfig): IntegrationEnvironment {
  const host = new URL(config.cloverBaseUrl).host.toLowerCase();
  return host.includes("sandbox") || host.includes("dev.clover.com") ? "STAGING" : "PRODUCTION";
}

export function getCloverDashboardConfig(config: AppConfig) {
  const siteUrl = new URL("/", config.appBaseUrl).toString();

  return {
    siteUrl,
    alternateLaunchPath: "/api/clover/install",
    oauthRedirectUri: new URL("/api/clover/oauth/callback", config.appBaseUrl).toString(),
    webhookUrl: new URL("/api/clover/webhooks", config.appBaseUrl).toString(),
    defaultOAuthResponse: "Code",
    initialSubscriptions: ["Orders"],
    initialPermissions: ["Read merchant", "Read orders", "Write orders"]
  };
}

export function getCloverEnvReadiness(config: AppConfig): CloverEnvReadinessItem[] {
  return [
    {
      name: "APP_BASE_URL",
      ready: config.appBaseUrl !== "http://localhost:3000",
      detail: config.appBaseUrl !== "http://localhost:3000" ? config.appBaseUrl : "Using the localhost default."
    },
    {
      name: "SESSION_SECRET",
      ready: config.sessionSecret !== "replace-me",
      detail: config.sessionSecret !== "replace-me" ? "Configured." : "Still using the development default."
    },
    {
      name: "CLOVER_APP_ID",
      ready: Boolean(config.cloverAppId),
      detail: config.cloverAppId ? "Configured." : "Missing."
    },
    {
      name: "CLOVER_APP_SECRET",
      ready: Boolean(config.cloverAppSecret),
      detail: config.cloverAppSecret ? "Configured." : "Missing."
    },
    {
      name: "CLOVER_WEBHOOK_AUTH_CODE",
      ready: Boolean(config.cloverWebhookAuthCode),
      detail: config.cloverWebhookAuthCode ? "Configured." : "Missing."
    },
    {
      name: "DATABASE_URL",
      ready: Boolean(config.databaseUrl),
      detail: config.databaseUrl ? "Configured." : "Missing."
    },
    {
      name: "REDIS_URL",
      ready: Boolean(config.redisUrl),
      detail: config.redisUrl ? "Configured." : "Missing."
    }
  ];
}
