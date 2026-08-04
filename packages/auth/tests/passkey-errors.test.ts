import { describe, expect, it } from "vitest";
import { normalizePasskeyError, resolvePasskeyFeedback } from "../src/client/passkey-errors.js";

describe("resolvePasskeyFeedback", () => {
  it("silences canceled authentication prompts", () => {
    expect(
      resolvePasskeyFeedback(
        new DOMException("The operation either timed out or was not allowed.", "NotAllowedError"),
        "authentication"
      )
    ).toEqual({ kind: "silent" });
  });

  it("turns duplicate registration into a softer info message", () => {
    expect(
      resolvePasskeyFeedback(new DOMException("The passkey already exists.", "InvalidStateError"), "registration")
    ).toEqual({
      kind: "feedback",
      tone: "info",
      message: "This device already has a passkey for the kitchen console. Try signing in with it instead."
    });
  });

  it("preserves curated server-side authentication failures", () => {
    expect(resolvePasskeyFeedback(new Error("Passkey verification expired. Try again."), "authentication")).toEqual({
      kind: "feedback",
      tone: "error",
      message: "Passkey verification expired. Try again."
    });
  });

  it("uses flow-specific fallback messages", () => {
    expect(resolvePasskeyFeedback({ name: "SecurityError" }, "authentication")).toEqual({
      kind: "feedback",
      tone: "error",
      message: "Passkey sign-in failed. Try again or use your password instead."
    });

    expect(normalizePasskeyError({ name: "SecurityError" }, "registration")).toEqual({
      kind: "feedback",
      tone: "error",
      message: "Passkey setup failed. Try again in a moment."
    });
  });
});
