import { describe, expect, it } from "vitest";

import {
  ipMatchesAllowlist,
  isValidIpAllowlist,
  isValidIpAllowlistEntry,
  parseIpAllowlist
} from "./ip-allowlist.js";

describe("parseIpAllowlist", () => {
  it("splits on commas, whitespace, and newlines, dropping blanks", () => {
    expect(parseIpAllowlist("1.2.3.4, 5.6.7.8\n9.9.9.9   10.0.0.0/8")).toEqual([
      "1.2.3.4",
      "5.6.7.8",
      "9.9.9.9",
      "10.0.0.0/8"
    ]);
    expect(parseIpAllowlist("   ")).toEqual([]);
    expect(parseIpAllowlist("")).toEqual([]);
  });
});

describe("isValidIpAllowlistEntry", () => {
  it("accepts IPv4, IPv4 CIDR, and IPv6 literals", () => {
    expect(isValidIpAllowlistEntry("203.0.113.7")).toBe(true);
    expect(isValidIpAllowlistEntry("203.0.113.0/24")).toBe(true);
    expect(isValidIpAllowlistEntry("0.0.0.0/0")).toBe(true);
    expect(isValidIpAllowlistEntry("2001:db8::1")).toBe(true);
  });

  it("rejects malformed entries", () => {
    expect(isValidIpAllowlistEntry("203.0.113.256")).toBe(false);
    expect(isValidIpAllowlistEntry("203.0.113.7/33")).toBe(false);
    expect(isValidIpAllowlistEntry("203.0.113")).toBe(false);
    expect(isValidIpAllowlistEntry("not-an-ip")).toBe(false);
    expect(isValidIpAllowlistEntry("2001:db8::1/64")).toBe(false); // v6 CIDR unsupported
  });
});

describe("isValidIpAllowlist", () => {
  it("treats empty as valid (allow-all) and validates every entry", () => {
    expect(isValidIpAllowlist("")).toBe(true);
    expect(isValidIpAllowlist("1.2.3.4\n5.6.7.0/24")).toBe(true);
    expect(isValidIpAllowlist("1.2.3.4\nbogus")).toBe(false);
  });
});

describe("ipMatchesAllowlist", () => {
  it("matches an exact IPv4", () => {
    expect(ipMatchesAllowlist("203.0.113.7", ["203.0.113.7"])).toBe(true);
    expect(ipMatchesAllowlist("203.0.113.8", ["203.0.113.7"])).toBe(false);
  });

  it("matches within an IPv4 CIDR (and not outside it)", () => {
    expect(ipMatchesAllowlist("203.0.113.42", ["203.0.113.0/24"])).toBe(true);
    expect(ipMatchesAllowlist("203.0.114.1", ["203.0.113.0/24"])).toBe(false);
    expect(ipMatchesAllowlist("10.1.2.3", ["10.0.0.0/8"])).toBe(true);
    expect(ipMatchesAllowlist("11.0.0.1", ["10.0.0.0/8"])).toBe(false);
  });

  it("0.0.0.0/0 matches any IPv4", () => {
    expect(ipMatchesAllowlist("8.8.8.8", ["0.0.0.0/0"])).toBe(true);
  });

  it("matches an IPv6 literal exactly and never a v4 CIDR", () => {
    expect(ipMatchesAllowlist("2001:db8::1", ["2001:db8::1"])).toBe(true);
    expect(ipMatchesAllowlist("2001:db8::2", ["2001:db8::1", "10.0.0.0/8"])).toBe(false);
  });
});
