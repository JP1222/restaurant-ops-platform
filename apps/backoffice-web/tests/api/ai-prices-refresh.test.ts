import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const refreshMock = vi.fn();
const sessionMock = vi.fn();

vi.mock("@/lib/ai/refresh-prices", () => ({
  refreshModelPrices: (...a: unknown[]) => refreshMock(...a),
}));
vi.mock("@/lib/ai/session", () => ({
  getAiSessionUser: (...a: unknown[]) => sessionMock(...a),
}));
vi.mock("@/lib/ai/log", () => ({
  logErrorEvent: vi.fn(),
  errorMessage: (_e: unknown, fallback: string) => fallback,
}));

const TOKEN = "cron-secret-123";
const RESULT = { modelCount: 7, fetchedAt: "2026-06-21T00:00:00.000Z" };

beforeEach(() => {
  refreshMock.mockReset().mockResolvedValue(RESULT);
  sessionMock.mockReset().mockResolvedValue(null);
  vi.resetModules();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function callPost(headers?: Record<string, string>) {
  const { POST } = await import("@/app/api/ai/prices/refresh/route");
  const { NextRequest } = await import("next/server");
  return POST(
    new NextRequest("http://localhost:3001/api/ai/prices/refresh", { method: "POST", headers }),
  );
}

describe("POST /api/ai/prices/refresh auth", () => {
  test("401 when there is no session and no cron token configured", async () => {
    vi.stubEnv("AI_PRICES_REFRESH_TOKEN", "");
    const res = await callPost();
    expect(res.status).toBe(401);
    expect(refreshMock).not.toHaveBeenCalled();
  });

  test("refreshes for an operator session (the Settings button path)", async () => {
    sessionMock.mockResolvedValue({ id: "u1" });
    const res = await callPost();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(RESULT);
    expect(refreshMock).toHaveBeenCalledOnce();
  });

  test("refreshes for the cron bearer token without a session", async () => {
    vi.stubEnv("AI_PRICES_REFRESH_TOKEN", TOKEN);
    const res = await callPost({ authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(200);
    expect(refreshMock).toHaveBeenCalledOnce();
  });

  test("401 for a wrong bearer token", async () => {
    vi.stubEnv("AI_PRICES_REFRESH_TOKEN", TOKEN);
    const res = await callPost({ authorization: "Bearer nope" });
    expect(res.status).toBe(401);
    expect(refreshMock).not.toHaveBeenCalled();
  });

  test("token branch is dormant when the env is unset (a Bearer header can't authorize)", async () => {
    vi.stubEnv("AI_PRICES_REFRESH_TOKEN", "");
    const res = await callPost({ authorization: "Bearer anything" });
    expect(res.status).toBe(401);
    expect(refreshMock).not.toHaveBeenCalled();
  });

  test("502 when the refresh fetch fails (prior cache left intact)", async () => {
    sessionMock.mockResolvedValue({ id: "u1" });
    refreshMock.mockRejectedValue(new Error("litellm_fetch_500"));
    const res = await callPost();
    expect(res.status).toBe(502);
  });
});
