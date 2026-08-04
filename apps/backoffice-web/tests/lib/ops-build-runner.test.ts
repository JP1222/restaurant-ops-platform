import { describe, expect, it } from "vitest";
import {
  buildRunnerSummary,
  parseBuildRunner,
  serializeBuildRunner,
} from "@/lib/ops/build-runner";

describe("parseBuildRunner", () => {
  it("defaults an empty value to balanced, all machines enabled", () => {
    const parsed = parseBuildRunner("");
    expect(parsed.strategy).toBe("balanced");
    expect(parsed.machines).toEqual([
      { key: "mac-mini", enabled: true },
      { key: "macbook", enabled: true },
    ]);
  });

  it("parses a balanced (comma) value in canonical order", () => {
    expect(parseBuildRunner("macbook").machines).toEqual([
      { key: "mac-mini", enabled: false },
      { key: "macbook", enabled: true },
    ]);
  });

  it("parses a priority (>) value preserving the encoded order", () => {
    const parsed = parseBuildRunner("macbook>mac-mini");
    expect(parsed.strategy).toBe("priority");
    expect(parsed.machines).toEqual([
      { key: "macbook", enabled: true },
      { key: "mac-mini", enabled: true },
    ]);
  });

  it("ignores unknown tokens", () => {
    const parsed = parseBuildRunner("bogus,mac-mini");
    expect(parsed.machines.find((m) => m.key === "mac-mini")?.enabled).toBe(true);
    expect(parsed.machines.find((m) => m.key === "macbook")?.enabled).toBe(false);
  });
});

describe("serializeBuildRunner round-trips parseBuildRunner", () => {
  it.each(["mac-mini,macbook", "macbook>mac-mini", "macbook"])("%s", (value) => {
    const parsed = parseBuildRunner(value);
    expect(serializeBuildRunner(parsed.strategy, parsed.machines)).toBe(value);
  });

  it("normalizes the unset sentinel to the explicit all-enabled list", () => {
    const parsed = parseBuildRunner("");
    expect(serializeBuildRunner(parsed.strategy, parsed.machines)).toBe("mac-mini,macbook");
  });
});

describe("buildRunnerSummary", () => {
  it("reads 'Any free Mac' when everything is enabled and balanced", () => {
    expect(buildRunnerSummary("balanced", parseBuildRunner("").machines)).toBe("Any free Mac");
  });

  it("uses arrows for priority order", () => {
    expect(buildRunnerSummary("priority", parseBuildRunner("macbook>mac-mini").machines)).toBe(
      "MacBook → Mac Mini",
    );
  });

  it("notes any-free when a subset is enabled", () => {
    expect(
      buildRunnerSummary("balanced", [
        { key: "mac-mini", enabled: true },
        { key: "macbook", enabled: false },
      ]),
    ).toBe("Mac Mini · any free");
  });
});
