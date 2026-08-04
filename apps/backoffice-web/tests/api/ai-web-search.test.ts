import { beforeEach, describe, expect, test, vi } from "vitest";

const sessionMock = vi.fn();
const getSettingMock = vi.fn();
const groundedWebSearchMock = vi.fn();

vi.mock("@/lib/ai/session", () => ({
  getAiSessionUser: (...args: unknown[]) => sessionMock(...args),
}));

vi.mock("@/lib/settings", () => ({
  getSetting: (...args: unknown[]) => getSettingMock(...args),
}));

vi.mock("@/lib/ai/grounded-search", () => ({
  groundedWebSearch: (...args: unknown[]) => groundedWebSearchMock(...args),
}));

vi.mock("@/lib/ai/log", () => ({
  logErrorEvent: () => {},
  errorMessage: (cause: unknown, fallback: string) =>
    cause instanceof Error ? cause.message : fallback,
}));

import { POST } from "@/app/api/ai/web-search/route";

function post(body: unknown): Request {
  return new Request("http://localhost/api/ai/web-search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/ai/web-search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionMock.mockResolvedValue({ id: "user-1", username: "op", displayName: "Op" });
    getSettingMock.mockResolvedValue(true);
    groundedWebSearchMock.mockResolvedValue({
      query: "boba price",
      answer: "About $30 a case.",
      sources: [{ title: "Supplier", url: "https://example.com/boba" }],
      available: true,
    });
  });

  test("401 when unauthenticated; never reaches the search provider", async () => {
    sessionMock.mockResolvedValueOnce(null);
    const response = await POST(post({ query: "news" }) as never);
    expect(response.status).toBe(401);
    expect(groundedWebSearchMock).not.toHaveBeenCalled();
  });

  test("400 on an invalid query (empty / oversized)", async () => {
    const empty = await POST(post({ query: "" }) as never);
    expect(empty.status).toBe(400);
    const oversized = await POST(post({ query: "x".repeat(201) }) as never);
    expect(oversized.status).toBe(400);
    expect(groundedWebSearchMock).not.toHaveBeenCalled();
  });

  test("kill switch OFF returns the clean unavailable payload; never calls Gemini", async () => {
    getSettingMock.mockResolvedValue(false);
    const response = await POST(post({ query: "any news?" }) as never);
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { available: boolean; sources: unknown[] };
    expect(payload.available).toBe(false);
    expect(payload.sources).toEqual([]);
    expect(groundedWebSearchMock).not.toHaveBeenCalled();
  });

  test("kill switch ON delegates to groundedWebSearch and returns the grounded result", async () => {
    const response = await POST(post({ query: "boba price" }) as never);
    expect(response.status).toBe(200);
    expect(groundedWebSearchMock).toHaveBeenCalledWith("boba price");
    const payload = (await response.json()) as {
      available: boolean;
      answer: string;
      sources: Array<{ url: string }>;
    };
    expect(payload.available).toBe(true);
    expect(payload.answer).toBe("About $30 a case.");
    expect(payload.sources[0]?.url).toBe("https://example.com/boba");
  });

  test("an unexpected grounded-search failure maps to a graceful unavailable payload, not a 500", async () => {
    groundedWebSearchMock.mockRejectedValueOnce(new Error("boom"));
    const response = await POST(post({ query: "boba price" }) as never);
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { available: boolean };
    expect(payload.available).toBe(false);
  });
});
