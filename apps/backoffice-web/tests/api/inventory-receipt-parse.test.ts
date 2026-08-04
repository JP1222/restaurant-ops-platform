import { beforeEach, describe, expect, test, vi } from "vitest";

const sessionMock = vi.fn();
const getSettingMock = vi.fn();
const checkRateLimitMock = vi.fn();
const parseReceiptMock = vi.fn();

// Stand-ins for the typed errors the route discriminates on. Defined via vi.hoisted
// so they're initialized before the hoisted vi.mock factories below read them
// eagerly — a plain class declaration would hit the TDZ ("Cannot access before
// initialization"). The route's `instanceof` checks resolve to these same classes.
const { MissingVisionKeyError, VisionTimeoutError, logErrorMock } = vi.hoisted(() => ({
  MissingVisionKeyError: class MissingVisionKeyError extends Error {
    constructor() {
      super("missing key");
      this.name = "MissingVisionKeyError";
    }
  },
  VisionTimeoutError: class VisionTimeoutError extends Error {
    readonly durationMs?: number;
    constructor(durationMs?: number) {
      super("vision model did not respond within 90s");
      this.name = "VisionTimeoutError";
      this.durationMs = durationMs;
    }
  },
  logErrorMock: vi.fn(),
}));

vi.mock("@/lib/ai/session", () => ({
  getAiSessionUser: (...args: unknown[]) => sessionMock(...args),
}));
vi.mock("@/lib/settings", () => ({
  getSetting: (...args: unknown[]) => getSettingMock(...args),
}));
vi.mock("@/lib/ai/rate-limit", () => ({
  checkAiRateLimit: (...args: unknown[]) => checkRateLimitMock(...args),
}));
vi.mock("@/lib/ai/receipt-parse", () => ({
  parseReceiptImage: (...args: unknown[]) => parseReceiptMock(...args),
  VisionTimeoutError,
}));
vi.mock("@/lib/ai/log", () => ({
  logErrorEvent: (...args: unknown[]) => logErrorMock(...args),
  errorMessage: (cause: unknown, fallback: string) =>
    cause instanceof Error ? cause.message : fallback,
}));
vi.mock("@/lib/ai/vision-provider", () => ({ MissingVisionKeyError }));

import { POST } from "@/app/api/inventory/receipt-parse/route";

function post(body: unknown): Request {
  return new Request("http://localhost/api/inventory/receipt-parse", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const VALID = { image_base64: "ZmFrZQ==", mime_type: "image/jpeg" };

describe("POST /api/inventory/receipt-parse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSettingMock.mockImplementation(async (key: string) => {
      if (key === "ai.kill_switch") return false;
      // Floor scan has its OWN bucket setting, separate from chat (#677 sibling fix).
      if (key === "ai.scan_rate_limit_per_minute") return 20;
      if (key === "ai.vision_model_id") return "gemini-flash-latest";
      return undefined;
    });
    sessionMock.mockResolvedValue({ id: "user-1" });
    checkRateLimitMock.mockResolvedValue({ ok: true });
    parseReceiptMock.mockResolvedValue({
      vendor: "Acme Foods",
      lines: [{ description: "Ahi tuna", qty: 2, unit_price_cents: 2200 }],
    });
  });

  test("503 when the AI kill switch is on (no auth/model work done)", async () => {
    getSettingMock.mockImplementation(async (key: string) =>
      key === "ai.kill_switch" ? true : 10,
    );
    const res = await POST(post(VALID) as never);
    expect(res.status).toBe(503);
    expect(sessionMock).not.toHaveBeenCalled();
  });

  test("401 when unauthenticated", async () => {
    sessionMock.mockResolvedValue(null);
    const res = await POST(post(VALID) as never);
    expect(res.status).toBe(401);
    expect(parseReceiptMock).not.toHaveBeenCalled();
  });

  test("429 when rate limited, against the scan bucket (not chat)", async () => {
    checkRateLimitMock.mockResolvedValue({ ok: false, retryAfterSeconds: 30 });
    const res = await POST(post(VALID) as never);
    expect(res.status).toBe(429);
    // Must meter the Floor scan on its own bucket so chat can't starve it.
    expect(checkRateLimitMock).toHaveBeenCalledWith("scan", 20);
  });

  test("400 on an invalid body (empty image or unsupported mime)", async () => {
    const res = await POST(post({ image_base64: "", mime_type: "image/gif" }) as never);
    expect(res.status).toBe(400);
    expect(parseReceiptMock).not.toHaveBeenCalled();
  });

  test("200 returns the parse result; the image is handed to the vision helper", async () => {
    const res = await POST(post(VALID) as never);
    expect(res.status).toBe(200);
    expect(parseReceiptMock).toHaveBeenCalledWith("ZmFrZQ==", "image/jpeg");
    expect(await res.json()).toMatchObject({ vendor: "Acme Foods" });
  });

  test("503 auth_not_configured when the vision key is missing (fail closed)", async () => {
    parseReceiptMock.mockRejectedValue(new MissingVisionKeyError());
    const res = await POST(post(VALID) as never);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "auth_not_configured" });
  });

  test("504 vision_timeout when the vision call exceeds its deadline", async () => {
    parseReceiptMock.mockRejectedValue(new VisionTimeoutError());
    const res = await POST(post(VALID) as never);
    expect(res.status).toBe(504);
    expect(await res.json()).toMatchObject({ error: "vision_timeout" });
  });

  test("504 timeout logs how long the vision call actually waited (latency observability)", async () => {
    parseReceiptMock.mockRejectedValue(new VisionTimeoutError(58_900));
    const res = await POST(post(VALID) as never);
    expect(res.status).toBe(504);
    expect(logErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "backoffice.api.inventory.receipt-parse",
        context: { latencyMs: 58_900 },
      }),
    );
  });

  test("502 when extraction fails for any other reason", async () => {
    parseReceiptMock.mockRejectedValue(new Error("model exploded"));
    const res = await POST(post(VALID) as never);
    expect(res.status).toBe(502);
  });

  // Internal service-to-service path (crew-web's scan BFF). A matching
  // INTERNAL_AI_TOKEN bearer stands in for a backoffice session.
  function postBearer(body: unknown, bearer: string): Request {
    return new Request("http://localhost/api/inventory/receipt-parse", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
      body: JSON.stringify(body),
    });
  }

  test("200 for a trusted internal bearer with no backoffice session", async () => {
    vi.stubEnv("INTERNAL_AI_TOKEN", "internal-secret-token-00");
    sessionMock.mockResolvedValue(null);
    const res = await POST(postBearer(VALID, "internal-secret-token-00") as never);
    expect(res.status).toBe(200);
    expect(parseReceiptMock).toHaveBeenCalledWith("ZmFrZQ==", "image/jpeg");
    vi.unstubAllEnvs();
  });

  test("401 for a wrong internal bearer when unauthenticated", async () => {
    vi.stubEnv("INTERNAL_AI_TOKEN", "internal-secret-token-00");
    sessionMock.mockResolvedValue(null);
    const res = await POST(postBearer(VALID, "WRONG") as never);
    expect(res.status).toBe(401);
    expect(parseReceiptMock).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
});
