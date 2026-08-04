import type { FastifyRequest } from "fastify";
import { CREW_SESSION_COOKIE_NAME, signCrewSession } from "@rop/auth/crew";
import type { PrismaClient } from "@rop/db-inventory";
import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import {
  FailureRateMonitor,
  RateLimiter,
  readCrewSession,
  resolveActor
} from "../src/lib/crew-auth.js";

const SECRET = "test-session-secret-0000000000";
const config = { crewSessionSecret: SECRET } as AppConfig;

const activeEmployee = { id: "EMP-1", name: "Maya", active: true };
const disabledEmployee = { id: "EMP-OFF", name: "Off Duty", active: false };
const prismaFake = {
  inventoryEmployee: {
    findUnique: async ({ where }: { where: { id: string } }) =>
      where.id === activeEmployee.id
        ? activeEmployee
        : where.id === disabledEmployee.id
          ? disabledEmployee
          : null
  }
} as unknown as PrismaClient;

function reqWithCookie(token?: string): FastifyRequest {
  return {
    cookies: token ? { [CREW_SESSION_COOKIE_NAME]: token } : {}
  } as unknown as FastifyRequest;
}

describe("RateLimiter", () => {
  it("locks only after max failures within the window", () => {
    const rl = new RateLimiter(3, 60_000);
    rl.recordFailure("ip");
    rl.recordFailure("ip");
    expect(rl.isLocked("ip")).toBe(false);
    rl.recordFailure("ip");
    expect(rl.isLocked("ip")).toBe(true);
  });

  it("reset clears the lock", () => {
    const rl = new RateLimiter(1, 60_000);
    rl.recordFailure("ip");
    expect(rl.isLocked("ip")).toBe(true);
    rl.reset("ip");
    expect(rl.isLocked("ip")).toBe(false);
  });

  it("expires the window", () => {
    vi.useFakeTimers();
    const rl = new RateLimiter(1, 1000);
    rl.recordFailure("ip");
    expect(rl.isLocked("ip")).toBe(true);
    vi.advanceTimersByTime(1001);
    expect(rl.isLocked("ip")).toBe(false);
    vi.useRealTimers();
  });

  it("tracks devices independently", () => {
    const rl = new RateLimiter(1, 60_000);
    rl.recordFailure("a");
    expect(rl.isLocked("a")).toBe(true);
    expect(rl.isLocked("b")).toBe(false);
  });

  // Issue #174: the hits map only shrinks on a successful login (reset). Under a
  // sustained probe of ever-changing keys it must NOT grow unboundedly — the cap
  // + oldest-eviction keep .size at or below maxBuckets.
  it("stays bounded after 50k distinct keys (caps at maxBuckets, drops oldest)", () => {
    const cap = 1000;
    const rl = new RateLimiter(5, 60_000, cap);
    for (let i = 0; i < 50_000; i++) {
      rl.recordFailure(`ip-${i}`);
    }
    expect(rl.size).toBeLessThanOrEqual(cap);
    // The most-recent key must survive (it was inserted last; oldest get evicted).
    expect(rl.isLocked("ip-49999")).toBe(false); // 1 failure < max, but tracked
    rl.recordFailure("ip-49999");
    rl.recordFailure("ip-49999");
    rl.recordFailure("ip-49999");
    rl.recordFailure("ip-49999");
    expect(rl.isLocked("ip-49999")).toBe(true);
  });

  // Issue #174: when keys expire (window elapsed) the opportunistic sweep on
  // recordFailure drains them, so a long-running process with churning keys
  // self-heals back toward empty rather than accumulating dead entries.
  it("sweeps expired entries so the map drains as windows elapse", () => {
    vi.useFakeTimers();
    const rl = new RateLimiter(5, 1000);
    for (let i = 0; i < 100; i++) {
      rl.recordFailure(`ip-${i}`);
    }
    expect(rl.size).toBe(100);
    // Let every window elapse, then record more failures with fresh keys. Each
    // recordFailure sweeps a slice of the (now-expired) front, so the stale 100
    // drain out instead of lingering forever.
    vi.advanceTimersByTime(1001);
    for (let i = 100; i < 200; i++) {
      rl.recordFailure(`ip-${i}`);
    }
    // The original 100 are all expired and should have been swept; only the 100
    // fresh keys (at most) remain.
    expect(rl.size).toBeLessThanOrEqual(100);
    vi.useRealTimers();
  });
});

describe("FailureRateMonitor", () => {
  const logger = () => {
    const warn = vi.fn();
    return { warn } as unknown as { warn: ReturnType<typeof vi.fn> };
  };

  it("alerts once when the aggregate failure rate crosses the threshold", () => {
    const log = logger();
    const mon = new FailureRateMonitor(3, 60_000);
    mon.record(log);
    mon.record(log);
    expect(log.warn).not.toHaveBeenCalled();
    mon.record(log); // 3rd within window -> alert
    expect(log.warn).toHaveBeenCalledTimes(1);
    // Stays quiet for the rest of the window (no per-failure spam).
    mon.record(log);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("re-arms in the next window", () => {
    vi.useFakeTimers();
    const log = logger();
    const mon = new FailureRateMonitor(2, 1000);
    mon.record(log);
    mon.record(log);
    expect(log.warn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1001); // window rolls over
    mon.record(log);
    mon.record(log);
    expect(log.warn).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

describe("readCrewSession / resolveActor", () => {
  it("returns the session + active actor (fresh name from the DB) for a valid cookie", async () => {
    const token = signCrewSession(
      { employeeId: "EMP-1", name: "Maya", exp: Date.now() + 60_000 },
      SECRET
    );
    expect(readCrewSession(reqWithCookie(token), config)?.name).toBe("Maya");
    expect(await resolveActor(prismaFake, reqWithCookie(token), config)).toEqual({
      id: "EMP-1",
      name: "Maya"
    });
  });

  it("returns null with no cookie", async () => {
    expect(readCrewSession(reqWithCookie(), config)).toBeNull();
    expect(await resolveActor(prismaFake, reqWithCookie(), config)).toBeNull();
  });

  it("returns null when the session's employee is disabled or removed", async () => {
    const disabled = signCrewSession(
      { employeeId: "EMP-OFF", name: "Off Duty", exp: Date.now() + 60_000 },
      SECRET
    );
    const gone = signCrewSession(
      { employeeId: "EMP-GONE", name: "Ghost", exp: Date.now() + 60_000 },
      SECRET
    );
    expect(await resolveActor(prismaFake, reqWithCookie(disabled), config)).toBeNull();
    expect(await resolveActor(prismaFake, reqWithCookie(gone), config)).toBeNull();
  });

  it("returns null when crew auth is unconfigured", () => {
    const token = signCrewSession(
      { employeeId: "EMP-1", name: "Maya", exp: Date.now() + 60_000 },
      SECRET
    );
    expect(readCrewSession(reqWithCookie(token), {} as AppConfig)).toBeNull();
  });
});
