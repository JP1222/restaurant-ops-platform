import { afterEach, describe, expect, it, vi } from "vitest";
import { apiJson } from "@/lib/api";

function jsonResponse(payload: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "content-type": "application/json"
    },
    ...init
  });
}

describe("apiJson", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not attach a JSON content-type header when the request has no body", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await apiJson<{ ok: true }>("/api/kds/tickets/ticket-1", {
      method: "DELETE"
    });

    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(requestInit.headers).get("content-type")).toBeNull();
  });

  it("attaches a JSON content-type header when a body is present", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await apiJson<{ ok: true }>("/api/kds/config", {
      method: "PUT",
      body: JSON.stringify({ soundEnabled: true })
    });

    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(requestInit.headers).get("content-type")).toBe("application/json");
  });

  it("preserves caller-provided content-type headers", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await apiJson<{ ok: true }>("/api/example", {
      method: "POST",
      body: "raw-body",
      headers: {
        "content-type": "text/plain"
      }
    });

    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(requestInit.headers).get("content-type")).toBe("text/plain");
  });

  it("surfaces server error payloads before falling back to the status code", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        {
          message: "Body cannot be empty when content-type is set to 'application/json'"
        },
        {
          status: 400
        }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      apiJson<{ ok: true }>("/api/kds/tickets/ticket-1", {
        method: "DELETE"
      })
    ).rejects.toThrow("Body cannot be empty when content-type is set to 'application/json'");
  });
});
