import { describe, expect, it } from "vitest";
import { getDevAuthBypassSession } from "../src/client/dev-auth-bypass.js";

describe("dev auth bypass", () => {
  it("stays disabled by default", () => {
    expect(getDevAuthBypassSession({ NODE_ENV: "development" })).toBeNull();
  });

  it("returns a local UI review session in development when explicitly enabled", () => {
    expect(
      getDevAuthBypassSession({
        NODE_ENV: "development",
        WEB_AUTH_DEV_BYPASS: "true"
      })
    ).toEqual({
      authenticated: true,
      username: "dev-ui-review",
      displayName: "Dev Kitchen Admin",
      hasPasskeys: false
    });
  });

  it("does not bypass auth in production even when the flag is set", () => {
    expect(
      getDevAuthBypassSession({
        NODE_ENV: "production",
        WEB_AUTH_DEV_BYPASS: "true"
      })
    ).toBeNull();
  });
});
