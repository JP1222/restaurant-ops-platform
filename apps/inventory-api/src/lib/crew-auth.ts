import type { FastifyRequest } from "fastify";
import {
  CREW_SESSION_COOKIE_NAME,
  verifyCrewSession,
  type CrewSessionPayload
} from "@rop/auth/crew";
import type { PrismaClient } from "@rop/db-inventory";

import type { AppConfig } from "../config.js";

// Read + verify the crew session from the request cookie. Returns null when the
// cookie is absent/malformed/expired, or when crew auth isn't configured.
export function readCrewSession(
  request: FastifyRequest,
  config: AppConfig
): CrewSessionPayload | null {
  const secret = config.crewSessionSecret;
  if (!secret) {
    return null;
  }
  const token = request.cookies?.[CREW_SESSION_COOKIE_NAME];
  if (!token) {
    return null;
  }
  return verifyCrewSession(token, secret);
}

// The authoritative actor for a write. A valid crew session wins and is derived
// server-side (never trusted from the request body); otherwise null, and the
// caller falls back to the body `who` supplied over the trusted bearer path.
// The session is a stateless token valid until expiry, so we re-check the
// employee against the DB: a disabled or removed employee resolves to null,
// which the write guard treats as "deny" — disabling locks them out at once.
//
// Memoized per request (2026-06-16 audit #8): a non-GET write resolves the actor
// twice — once in the app.ts write guard, once in the route handler. The session
// and employee state can't change within a single request, so the result is cached
// on the request via a WeakMap (auto-collected with the request, no `any` cast, no
// request mutation), collapsing the two DB lookups into one.
const actorCache = new WeakMap<
  FastifyRequest,
  { id: string; name: string; locationId: string } | null
>();

export async function resolveActor(
  prisma: PrismaClient,
  request: FastifyRequest,
  config: AppConfig
): Promise<{ id: string; name: string; locationId: string } | null> {
  const cached = actorCache.get(request);
  if (cached !== undefined) {
    return cached;
  }
  const session = readCrewSession(request, config);
  if (!session) {
    actorCache.set(request, null);
    return null;
  }
  const employee = await prisma.inventoryEmployee.findUnique({
    where: { id: session.employeeId }
  });
  const actor =
    !employee || !employee.active
      ? null
      : { id: employee.id, name: employee.name, locationId: employee.locationId };
  actorCache.set(request, actor);
  return actor;
}

// Hard cap on the number of distinct buckets the limiter holds at once. The map
// only shrinks on a successful login (`reset`), so under a sustained probe every
// unique (IP, PIN-prefix) an attacker tries would otherwise live in memory until
// the process restarts (issue #174). Two cheap defenses keep it bounded:
//   - every `recordFailure` opportunistically sweeps a small slice for expired
//     keys (O(1) amortized — no full scan), and
//   - when the map is full we evict the oldest entry before inserting.
// Map preserves insertion order, so the first iterated key is the oldest. When
// this service eventually moves to Redis (multi-process), this cap goes away —
// Redis TTLs evict for us. Documented in apps/inventory-api/AGENTS.md.
const MAX_BUCKETS = 10_000;

// How many entries to probe per `recordFailure` for opportunistic eviction. A
// small fixed slice keeps the common path O(1) while still draining stale keys
// faster than new failures arrive under any realistic probe rate.
const SWEEP_SLICE = 20;

// In-memory fixed-window limiter keyed by device/IP. inventory-api has no Redis,
// and a PIN-only login can't be keyed per-employee (the employee is unknown until
// after verification), so we lock the device. Single store, single process today.
// Bounded at MAX_BUCKETS entries (see above) so a sustained probe can't grow it
// without limit.
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly maxBuckets: number = MAX_BUCKETS
  ) {}

  private active(key: string, now: number): { count: number; resetAt: number } | null {
    const entry = this.hits.get(key);
    if (!entry || now >= entry.resetAt) {
      return null;
    }
    return entry;
  }

  // Drop up to SWEEP_SLICE expired entries from the front of the map. Iteration
  // is insertion-ordered, and an entry's window length is fixed, so the oldest
  // entries are also the soonest to expire — scanning the front is where stale
  // keys cluster. Deleting mid-iteration is safe for already-yielded keys.
  private sweepExpired(now: number): void {
    let scanned = 0;
    for (const [key, entry] of this.hits) {
      if (scanned >= SWEEP_SLICE) {
        break;
      }
      if (now >= entry.resetAt) {
        this.hits.delete(key);
      }
      scanned += 1;
    }
  }

  isLocked(key: string): boolean {
    const entry = this.active(key, Date.now());
    return entry !== null && entry.count >= this.max;
  }

  recordFailure(key: string): void {
    const now = Date.now();
    const entry = this.active(key, now);
    if (entry) {
      entry.count += 1;
      return;
    }
    // New (or expired) key. Opportunistically drain stale entries first so the
    // map self-heals under a probe of ever-changing keys.
    this.sweepExpired(now);
    // Still full after the sweep (every entry live)? Evict the oldest to make
    // room — bounds memory even in the pathological all-live case.
    if (!this.hits.has(key) && this.hits.size >= this.maxBuckets) {
      const oldest = this.hits.keys().next().value;
      if (oldest !== undefined) {
        this.hits.delete(oldest);
      }
    }
    this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  // Current number of tracked buckets. Exposed for tests / observability; the
  // limiter caps this at `maxBuckets`.
  get size(): number {
    return this.hits.size;
  }
}

// Detect a distributed brute-force the per-key RateLimiter can't see: an attacker
// rotating IPs (or sharding across PIN prefixes) stays under every individual
// bucket while the AGGREGATE failed-login rate spikes far above any real kitchen.
// This rolls a fixed window of total failures across all devices and emits ONE
// structured warning per window when the rate crosses the threshold — a hook the
// ops log pipeline can alert on. It never blocks (that would let an attacker DoS
// legit logins); it only observes.
export interface RateMonitorLogger {
  warn(obj: Record<string, unknown>, msg?: string): void;
}

export class FailureRateMonitor {
  private windowStart = 0;
  private count = 0;
  private alerted = false;

  constructor(
    private readonly threshold: number,
    private readonly windowMs: number
  ) {}

  // Record one failed login. Logs at most once per window when the count first
  // crosses the threshold. No PIN / token / customer data is logged — only counts.
  record(log: RateMonitorLogger): void {
    const now = Date.now();
    if (now - this.windowStart >= this.windowMs) {
      this.windowStart = now;
      this.count = 0;
      this.alerted = false;
    }
    this.count += 1;
    if (this.count >= this.threshold && !this.alerted) {
      this.alerted = true;
      log.warn(
        {
          event: "crew_login_bruteforce_suspected",
          failures: this.count,
          window_ms: this.windowMs
        },
        "crew login failure rate exceeded threshold — possible distributed brute force"
      );
    }
  }
}
