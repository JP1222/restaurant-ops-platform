import { describe, expect, it } from "vitest";
import { fullBackfillWindows, sampleWindow } from "../src/backfill/windows.js";

describe("backfill windows", () => {
  it("creates a 7 day sample window ending at now", () => {
    const now = new Date("2026-04-26T12:00:00.000Z");
    const [window] = sampleWindow(7, now);
    expect(window?.start.toISOString()).toBe("2026-04-19T12:00:00.000Z");
    expect(window?.end.toISOString()).toBe("2026-04-26T12:00:00.000Z");
  });

  it("splits full backfills into 30 day windows", () => {
    const windows = fullBackfillWindows(
      new Date("2026-01-01T00:00:00.000Z"),
      new Date("2026-03-05T00:00:00.000Z")
    );
    expect(windows.map((window) => [
      window.start.toISOString().slice(0, 10),
      window.end.toISOString().slice(0, 10)
    ])).toEqual([
      ["2026-01-01", "2026-01-31"],
      ["2026-01-31", "2026-03-02"],
      ["2026-03-02", "2026-03-05"]
    ]);
  });
});

