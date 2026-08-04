import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBackofficeAdminUrl, getBackofficeBaseUrl } from "@/lib/env";

describe("kds-web env helpers", () => {
  const originalEnv = process.env.NEXT_PUBLIC_BACKOFFICE_BASE_URL;

  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_BACKOFFICE_BASE_URL;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.NEXT_PUBLIC_BACKOFFICE_BASE_URL;
    } else {
      process.env.NEXT_PUBLIC_BACKOFFICE_BASE_URL = originalEnv;
    }
  });

  it("falls back to the production Backoffice host when the env is unset", () => {
    expect(getBackofficeBaseUrl()).toBe("https://backoffice.example.com");
  });

  it("strips a trailing slash from the configured env", () => {
    process.env.NEXT_PUBLIC_BACKOFFICE_BASE_URL = "https://example.com/";
    expect(getBackofficeBaseUrl()).toBe("https://example.com");
  });

  it("treats an empty string env value as unset", () => {
    process.env.NEXT_PUBLIC_BACKOFFICE_BASE_URL = "";
    expect(getBackofficeBaseUrl()).toBe("https://backoffice.example.com");
  });

  it("joins a base URL with a path that already has a leading slash", () => {
    process.env.NEXT_PUBLIC_BACKOFFICE_BASE_URL = "https://example.com";
    expect(getBackofficeAdminUrl("/admin/board")).toBe("https://example.com/admin/board");
  });

  it("adds the leading slash when missing", () => {
    process.env.NEXT_PUBLIC_BACKOFFICE_BASE_URL = "https://example.com";
    expect(getBackofficeAdminUrl("admin/integrations")).toBe("https://example.com/admin/integrations");
  });
});
