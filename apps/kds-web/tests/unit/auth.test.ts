import { describe, expect, it } from "vitest";
import { buildBoardSettingsHref, buildLoginHref, buildPostLoginDestination, normalizeReturnToPath } from "@/lib/auth";

describe("web auth helpers", () => {
  it("normalizes returnTo paths and rejects external redirects", () => {
    expect(normalizeReturnToPath("/board?merchantId=abc")).toBe("/board?merchantId=abc");
    expect(normalizeReturnToPath("https://evil.example.com")).toBe("/board");
    expect(normalizeReturnToPath(undefined, "/login")).toBe("/login");
  });

  it("builds login redirects with encoded returnTo values", () => {
    expect(buildLoginHref("/board?merchantId=abc")).toBe("/login?returnTo=%2Fboard%3FmerchantId%3Dabc");
  });

  it("returns admins to the requested board path after login", () => {
    expect(
      buildPostLoginDestination(
        {
          authenticated: true,
          username: "admin",
          displayName: "Kitchen Admin",
          hasPasskeys: false
        },
        "/board?merchantId=abc"
      )
    ).toBe("/board?merchantId=abc");

    expect(
      buildPostLoginDestination(
        {
          authenticated: true,
          username: "admin",
          displayName: "Kitchen Admin",
          hasPasskeys: true
        },
        "/board?merchantId=abc"
      )
    ).toBe("/board?merchantId=abc");
  });

  it("maps legacy setup-passkey flows back into board settings", () => {
    expect(buildBoardSettingsHref("/board?merchantId=abc")).toBe("/board?merchantId=abc&drawer=settings");

    expect(
      buildPostLoginDestination(
        {
          authenticated: true,
          username: "admin",
          displayName: "Kitchen Admin",
          hasPasskeys: false
        },
        "/setup-passkey?returnTo=%2Fboard%3FmerchantId%3Dabc"
      )
    ).toBe("/board?merchantId=abc&drawer=settings");
  });
});
