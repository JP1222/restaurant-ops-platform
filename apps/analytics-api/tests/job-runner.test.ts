import { describe, expect, it } from "vitest";
import { classifyBackfillError } from "../src/scheduler/job-runner.js";

// classifyBackfillError decides whether a historical-backfill window failure is
// retryable (parked with a cooldown) or permanently blocked (manual attention).
// This is the exact decision the head-of-line / stuck-forever behaviour hinges on
// (P1/P2), so it is exercised directly here.
describe("classifyBackfillError", () => {
  it("treats throttling and transient server errors as retryable", () => {
    for (const message of [
      "Clover request failed with 429.",
      "Clover request failed with 500.",
      "Clover request failed with 503.",
      "rate limit exceeded",
      "request timed out",
      "ECONNRESET",
      "fetch failed",
      "temporary network error"
    ]) {
      const result = classifyBackfillError(new Error(message));
      expect(result.blocked, message).toBe(false);
      expect(result.errorClass, message).toBe("retryable");
    }
  });

  it("classifies the unexpected-export-status failure as retryable, not blocked", () => {
    // The P11 waitForExport fix throws "...unexpected status X (temporary)." — it
    // must NOT be classified as permanently blocked.
    const result = classifyBackfillError(
      new Error("Clover export abc returned unexpected status QUEUED (temporary).")
    );
    expect(result.blocked).toBe(false);
    expect(result.errorClass).toBe("retryable");
  });

  it("blocks on auth, permission and schema/payload errors", () => {
    for (const message of [
      "Clover request failed with 401.",
      "Clover request failed with 403.",
      "Clover request failed with 404.",
      "unauthorized",
      "forbidden",
      "invalid token",
      "permission denied",
      "unsupported export type",
      "invalid payload",
      "schema mismatch"
    ]) {
      const result = classifyBackfillError(new Error(message));
      expect(result.blocked, message).toBe(true);
      expect(result.errorClass, message).toBe("manual_attention");
    }
  });

  it("defaults an unrecognised error to retryable (never silently blocks)", () => {
    const result = classifyBackfillError(new Error("something weird happened"));
    expect(result.blocked).toBe(false);
    expect(result.errorClass).toBe("retryable_unknown");
  });

  it("accepts non-Error values", () => {
    expect(classifyBackfillError("plain 503 string").blocked).toBe(false);
    expect(classifyBackfillError(null).errorClass).toBe("retryable_unknown");
  });
});
