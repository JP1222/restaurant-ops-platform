import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, requireCloverServiceConfig } from "../src/config.js";

const SAVED_ENV = { ...process.env };

describe("config loading", () => {
  afterEach(() => {
    process.env = { ...SAVED_ENV };
  });

  it("treats empty optional secret env vars as unset", () => {
    process.env.DATABASE_URL = "postgresql://user:pass@example.test:5432/db";
    process.env.CLOVER_MERCHANT_ID = "merchant_1";
    process.env.CLOVER_TOKEN = "token_1";
    process.env.CLOVER_WEBHOOK_AUTH_CODE = "";
    process.env.ADMIN_TOKEN = "";

    const config = loadConfig();
    const clover = requireCloverServiceConfig(config);

    expect(config.cloverWebhookAuthCode).toBeUndefined();
    expect(config.adminToken).toBeUndefined();
    expect(clover.webhookAuthCode).toBeNull();
  });
});
