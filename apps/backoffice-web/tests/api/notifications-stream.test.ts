import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// BFF SSE relay (app/api/notifications/stream): the browser's EventSource connects
// here, the route resolves the session operator and pipes notifications-api's
// bearer-authenticated stream through. We mock the session resolver + the upstream
// opener but keep the REAL error→response mapping (handleNotificationsApiError) and
// the real error classes, so the 503/502/instanceof paths are exercised for real.
const operatorIdMock = vi.fn();
const openStreamMock = vi.fn();

vi.mock("@/lib/notifications-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/notifications-api")>("@/lib/notifications-api");
  return {
    ...actual,
    operatorIdFromRequest: (...args: unknown[]) => operatorIdMock(...args),
    openNotificationsStream: (...args: unknown[]) => openStreamMock(...args)
  };
});

beforeEach(() => {
  operatorIdMock.mockReset();
  openStreamMock.mockReset();
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function callGet(signal?: AbortSignal) {
  const { GET } = await import("@/app/api/notifications/stream/route");
  const { NextRequest } = await import("next/server");
  const url = "http://localhost:3001/api/notifications/stream";
  // Pass `{ signal }` as an inline literal (structurally checked against Next's
  // RequestInit) rather than a global-RequestInit-typed variable, which doesn't
  // assign to NextRequest's augmented init type.
  const req = signal ? new NextRequest(url, { signal }) : new NextRequest(url);
  return GET(req);
}

describe("GET /api/notifications/stream (BFF SSE relay)", () => {
  test("401 when unauthenticated — never opens an upstream connection", async () => {
    operatorIdMock.mockResolvedValue(null);
    const res = await callGet();
    expect(res.status).toBe(401);
    expect(openStreamMock).not.toHaveBeenCalled();
  });

  test("503 when notifications-api is unconfigured (sample-data fallback)", async () => {
    operatorIdMock.mockResolvedValue("alice");
    const { NotificationsApiNotConfiguredError } = await import("@/lib/notifications-api");
    openStreamMock.mockRejectedValue(new NotificationsApiNotConfiguredError(["INTERNAL_NOTIFICATIONS_API_URL"]));
    const res = await callGet();
    expect(res.status).toBe(503);
  });

  test("502 on a genuine upstream error", async () => {
    operatorIdMock.mockResolvedValue("alice");
    const { NotificationsApiError } = await import("@/lib/notifications-api");
    openStreamMock.mockRejectedValue(
      new NotificationsApiError(500, "boom", "http://notifications-api:4400/api/notifications/stream")
    );
    const res = await callGet();
    expect(res.status).toBe(502);
  });

  test("pipes the upstream SSE stream as text/event-stream, scoped to the operator", async () => {
    operatorIdMock.mockResolvedValue("alice");
    openStreamMock.mockResolvedValue(
      new Response(new ReadableStream(), { status: 200, headers: { "content-type": "text/event-stream" } })
    );
    const res = await callGet();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    // operator id stamped + an AbortSignal forwarded for disconnect propagation.
    expect(openStreamMock).toHaveBeenCalledWith("alice", expect.any(AbortSignal));
  });

  test("204 when the browser disconnected before the upstream opened", async () => {
    operatorIdMock.mockResolvedValue("alice");
    openStreamMock.mockRejectedValue(new Error("aborted"));
    const res = await callGet(AbortSignal.abort());
    expect(res.status).toBe(204);
  });
});
