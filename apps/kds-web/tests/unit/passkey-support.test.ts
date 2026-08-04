import React from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@simplewebauthn/browser", () => ({
  browserSupportsWebAuthn: vi.fn(() => true),
  startAuthentication: vi.fn(),
  startRegistration: vi.fn()
}));

import { browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { LoginScreen } from "@/components/login-screen";
import {
  isPasskeyActionDisabled,
  shouldShowPasskeyUnsupported
} from "@rop/auth/client";

describe("passkey support UI state", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not run browser passkey detection during server render", () => {
    vi.stubGlobal("React", React);

    const html = renderToString(React.createElement(LoginScreen, { returnTo: "/board" }));

    expect(browserSupportsWebAuthn).not.toHaveBeenCalled();
    expect(html).toContain("Checking passkey support");
    expect(html).toContain("disabled=\"\"");
  });

  it("treats unknown, supported, and unsupported passkey states distinctly", () => {
    expect(isPasskeyActionDisabled(null, false)).toBe(true);
    expect(isPasskeyActionDisabled(true, false)).toBe(false);
    expect(isPasskeyActionDisabled(true, true)).toBe(true);
    expect(isPasskeyActionDisabled(false, false)).toBe(true);

    expect(shouldShowPasskeyUnsupported(null)).toBe(false);
    expect(shouldShowPasskeyUnsupported(true)).toBe(false);
    expect(shouldShowPasskeyUnsupported(false)).toBe(true);
  });
});
