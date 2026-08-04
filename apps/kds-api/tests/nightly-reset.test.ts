import { describe, expect, it } from "vitest";
import { shouldRunNightlyReset } from "../src/jobs/nightly-reset.js";

describe("shouldRunNightlyReset", () => {
  it("waits until the configured hour", () => {
    expect(shouldRunNightlyReset(new Date("2026-04-21T20:59:59.000Z"), null, "UTC", 21)).toBe(false);
    expect(shouldRunNightlyReset(new Date("2026-04-21T21:00:00.000Z"), null, "UTC", 21)).toBe(true);
  });

  it("runs only once per local day", () => {
    expect(
      shouldRunNightlyReset(
        new Date("2026-04-21T22:30:00.000Z"),
        new Date("2026-04-21T21:15:00.000Z"),
        "UTC",
        21
      )
    ).toBe(false);

    expect(
      shouldRunNightlyReset(
        new Date("2026-04-21T22:30:00.000Z"),
        new Date("2026-04-20T21:15:00.000Z"),
        "UTC",
        21
      )
    ).toBe(true);
  });

  it("uses the configured timezone when deciding the reset window", () => {
    expect(shouldRunNightlyReset(new Date("2026-04-22T01:59:59.000Z"), null, "America/Chicago", 21)).toBe(false);
    expect(shouldRunNightlyReset(new Date("2026-04-22T02:00:00.000Z"), null, "America/Chicago", 21)).toBe(true);
  });

  it("honors minute-level reset times", () => {
    expect(shouldRunNightlyReset(new Date("2026-04-21T21:14:59.000Z"), null, "UTC", 21, 15)).toBe(false);
    expect(shouldRunNightlyReset(new Date("2026-04-21T21:15:00.000Z"), null, "UTC", 21, 15)).toBe(true);
  });
});
