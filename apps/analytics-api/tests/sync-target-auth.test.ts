import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";

import type { AppConfig } from "../src/config.js";
import { isAdminAuthorized, isSyncTargetWriteAuthorized } from "../src/http/admin.js";

function req(authorization?: string): IncomingMessage {
  return { headers: authorization ? { authorization } : {} } as IncomingMessage;
}

const config = { adminToken: "admin-tok", kdsAnalyticsPushToken: "push-tok" } as AppConfig;

describe("sync-target write authorization (Square token push)", () => {
  it("accepts the admin token", () => {
    expect(isSyncTargetWriteAuthorized(req("Bearer admin-tok"), config)).toBe(true);
  });

  it("accepts the dedicated kds analytics push token", () => {
    expect(isSyncTargetWriteAuthorized(req("Bearer push-tok"), config)).toBe(true);
  });

  it("rejects an unknown / missing token", () => {
    expect(isSyncTargetWriteAuthorized(req("Bearer nope"), config)).toBe(false);
    expect(isSyncTargetWriteAuthorized(req(), config)).toBe(false);
  });

  it("does NOT accept the push token when it is unset (no accidental open door)", () => {
    const noPush = { adminToken: "admin-tok" } as AppConfig;
    expect(isSyncTargetWriteAuthorized(req("Bearer push-tok"), noPush)).toBe(false);
    expect(isSyncTargetWriteAuthorized(req("Bearer admin-tok"), noPush)).toBe(true);
  });

  it("the push token does NOT unlock the broader admin surface (scope is narrow)", () => {
    // isAdminAuthorized gates the other /admin routes — it must reject the push token.
    expect(isAdminAuthorized(req("Bearer push-tok"), config)).toBe(false);
    expect(isAdminAuthorized(req("Bearer admin-tok"), config)).toBe(true);
  });
});
