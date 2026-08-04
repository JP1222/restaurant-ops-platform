import { describe, expect, it } from "vitest";
import {
  isConditionalUiSupported,
  isPasskeyActionDisabled,
  isPasskeySupported,
  shouldShowPasskeyUnsupported
} from "../src/client/passkey-support.js";

describe("passkey support helpers", () => {
  it("treats unknown, supported, and unsupported passkey states distinctly", () => {
    expect(isPasskeyActionDisabled(null, false)).toBe(true);
    expect(isPasskeyActionDisabled(true, false)).toBe(false);
    expect(isPasskeyActionDisabled(true, true)).toBe(true);
    expect(isPasskeyActionDisabled(false, false)).toBe(true);

    expect(shouldShowPasskeyUnsupported(null)).toBe(false);
    expect(shouldShowPasskeyUnsupported(true)).toBe(false);
    expect(shouldShowPasskeyUnsupported(false)).toBe(true);
  });

  it("wraps passkey support detection and treats thrown errors as unsupported", () => {
    expect(isPasskeySupported(() => true)).toBe(true);
    expect(isPasskeySupported(() => false)).toBe(false);
    expect(isPasskeySupported(() => {
      throw new Error("blocked");
    })).toBe(false);
  });

  it("wraps conditional UI detection and treats rejected checks as unsupported", async () => {
    await expect(isConditionalUiSupported(async () => true)).resolves.toBe(true);
    await expect(isConditionalUiSupported(async () => false)).resolves.toBe(false);
    await expect(isConditionalUiSupported(async () => {
      throw new Error("blocked");
    })).resolves.toBe(false);
  });
});
