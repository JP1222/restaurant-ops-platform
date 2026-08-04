import { afterEach, describe, expect, it, vi } from "vitest";
import type { SquareConnectStore } from "@rop/contracts";

import type { AppConfig } from "../src/config.js";
import { pushSquareSyncTargets } from "../src/lib/square-analytics-sync.js";

type LogCall = { fields: Record<string, unknown>; msg: string };

function fakeLog() {
  const calls: Record<"debug" | "info" | "warn", LogCall[]> = { debug: [], info: [], warn: [] };
  const make = (level: "debug" | "info" | "warn") => (fields: Record<string, unknown>, msg: string) =>
    calls[level].push({ fields, msg });
  return {
    log: { debug: make("debug"), info: make("info"), warn: make("warn"), error: make("warn") } as never,
    calls,
  };
}

const STORES: SquareConnectStore[] = [
  { posStoreId: "square:LOC1", providerStoreId: "LOC1", name: "Downtown", timezone: "America/Chicago", currency: "USD", locationId: "loc-1" },
];
const TOKEN = "sq0atp-SUPER-SECRET-TOKEN";

afterEach(() => vi.unstubAllGlobals());

describe("pushSquareSyncTargets", () => {
  it("is a no-op when analytics is not configured (no fetch)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { log } = fakeLog();
    await pushSquareSyncTargets({} as AppConfig, STORES, TOKEN, log);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("POSTs one sync target per store with the push bearer + provider=square", async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }) as Response);
    vi.stubGlobal("fetch", fetchSpy);
    const { log } = fakeLog();
    const config = { analyticsInternalUrl: "http://analytics:3100", kdsAnalyticsPushToken: "push-tok" } as AppConfig;

    await pushSquareSyncTargets(config, STORES, TOKEN, log);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe("http://analytics:3100/admin/api/sync-targets");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer push-tok" });
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body).toEqual({
      merchant_id: "square:LOC1",
      provider: "square",
      token: TOKEN,
      store_timezone: "America/Chicago",
      active: true,
    });
  });

  it("never logs the raw token (only tokenLast4)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 }) as Response));
    const { log, calls } = fakeLog();
    const config = { analyticsInternalUrl: "http://analytics:3100", kdsAnalyticsPushToken: "push-tok" } as AppConfig;

    await pushSquareSyncTargets(config, STORES, TOKEN, log);

    const serialized = JSON.stringify(calls);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).toContain(TOKEN.slice(-4)); // only tokenLast4 is logged
  });

  it("is best-effort: a fetch failure does not throw", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }));
    const { log } = fakeLog();
    const config = { analyticsInternalUrl: "http://analytics:3100", kdsAnalyticsPushToken: "push-tok" } as AppConfig;
    await expect(pushSquareSyncTargets(config, STORES, TOKEN, log)).resolves.toBeUndefined();
  });
});
