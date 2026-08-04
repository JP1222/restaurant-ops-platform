import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createNotificationsEmitter } from "../src/lib/notifications-client.js";

const payload = {
  severity: "warn" as const,
  category: "inv" as const,
  categoryLabel: "Inventory",
  icon: "ban",
  title: "Salmon roll 86'd",
  detail: "Marked unavailable by Backoffice.",
  action: { label: "View item", icon: "package", href: "/inventory/items/salmon" }
};

const CONFIG = { baseUrl: "http://notifications-api:4400", token: "tok-0000000000000000" };

describe("notifications emitter", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("no-ops when unconfigured and never calls fetch", async () => {
    const emitter = createNotificationsEmitter({});
    expect(emitter.configured).toBe(false);
    await emitter.emit(payload);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs to the ingest endpoint with bearer + JSON body when configured", async () => {
    fetchMock.mockResolvedValue({ ok: true, text: async () => "" });
    const emitter = createNotificationsEmitter(CONFIG);
    expect(emitter.configured).toBe(true);

    await emitter.emit(payload);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] ?? [];
    const url = call[0];
    const init = (call[1] ?? {}) as { method?: string; headers?: Record<string, string>; body?: string };
    expect(String(url)).toBe("http://notifications-api:4400/api/notifications/ingest");
    expect(init.method).toBe("POST");
    expect(init.headers?.Authorization).toBe("Bearer tok-0000000000000000");
    expect(JSON.parse(init.body ?? "{}")).toMatchObject({ title: "Salmon roll 86'd", category: "inv" });
  });

  it("rejects on a non-ok response so the caller can log it", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, text: async () => "down" });
    const emitter = createNotificationsEmitter(CONFIG);
    await expect(emitter.emit(payload)).rejects.toThrow(/503/);
  });
});
