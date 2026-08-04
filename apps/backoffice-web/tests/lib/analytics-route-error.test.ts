import { afterEach, describe, expect, it, vi } from "vitest";

import { AnalyticsApiError, handleAnalyticsApiError } from "@/lib/analytics-api";

const SCOPE = "backoffice.api.test";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleAnalyticsApiError", () => {
  it("maps an AnalyticsApiError to a 502 upstream_error response", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = handleAnalyticsApiError(
      new AnalyticsApiError(503, "service unavailable", "http://analytics/admin/api/costs"),
      SCOPE,
    );

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toEqual({
      error: "upstream_error",
      upstream_status: 503,
    });
  });

  it("maps a generic Error to a 500 internal_error response", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = handleAnalyticsApiError(new Error("boom"), SCOPE);

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "internal_error" });
  });

  it("maps a non-Error throw to a 500 internal_error response", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = handleAnalyticsApiError("not-an-error", SCOPE);

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "internal_error" });
  });

  it("logs scope + upstreamStatus and redacts secrets from the upstream body", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const leakedBody =
      "auth failed: Authorization: Bearer sk-live-supersecrettoken1234567890";

    handleAnalyticsApiError(new AnalyticsApiError(500, leakedBody, "http://analytics"), SCOPE);

    const parsed = JSON.parse(errorSpy.mock.calls[0]?.[0] as string);
    expect(parsed).toMatchObject({ level: "error", scope: SCOPE, upstreamStatus: 500 });
    expect(parsed.message).toContain("[REDACTED]");
    expect(parsed.message).not.toContain("sk-live-supersecrettoken1234567890");
  });

  it("redacts secrets from a non-upstream Error message before logging", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    handleAnalyticsApiError(
      new Error("connect failed postgres://user:pw@db:5432/analytics"),
      SCOPE,
    );

    const parsed = JSON.parse(errorSpy.mock.calls[0]?.[0] as string);
    expect(parsed.message).toContain("[REDACTED]");
    expect(parsed.message).not.toContain("postgres://");
  });
});
