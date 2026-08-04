import type { FastifyInstance } from "fastify";
import {
  CREW_SESSION_COOKIE_NAME,
  pinLookupHash,
  signCrewSession,
  verifyPin
} from "@rop/auth/crew";
import { z } from "zod";

import type { AppServices } from "../lib/services.js";
import { FailureRateMonitor, RateLimiter, readCrewSession } from "../lib/crew-auth.js";

const LoginSchema = z.object({ pin: z.string().min(4).max(12) });

// Backstop TTL for the stateless session (a shift). The floor app also auto-logs
// out on idle; this just bounds how long a stolen cookie stays valid.
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

// Lock a device after 5 failed PIN attempts within 15 minutes. Keyed per
// (IP, PIN-prefix) so one cook's fat-finger doesn't lock the next cook out.
const MAX_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

// Second tier: a per-IP cap ACROSS prefixes. Without it the prefix sharding lets a
// single IP try MAX_ATTEMPTS × 100 prefixes = 500 PINs / window — a 100× hole in
// front of a small PIN space. A real store sits behind one NAT IP, so this is sized
// well above plausible legit fat-fingering (even a busy shared iPad) but far below
// what a brute-forcer needs. Combined with the longer PIN it makes single-IP brute
// force impractical; distributed brute force is caught by the monitor below and
// blocked at the edge (internal-only API + optional IP allowlist).
const IP_MAX_ATTEMPTS = 60;

// Aggregate brute-force alarm: total failed logins across ALL devices per minute.
// A whole kitchen mistyping can't approach this; crossing it means an automated
// sweep. Observe-and-alert only (never block — that would DoS real logins).
const GLOBAL_ALERT_THRESHOLD = 50;
const GLOBAL_ALERT_WINDOW_MS = 60 * 1000;

interface EmployeeRow {
  id: string;
  name: string;
  role: string;
  shift: string;
  initials: string;
  color: string;
}

function publicEmployee(e: EmployeeRow) {
  return { id: e.id, name: e.name, role: e.role, shift: e.shift, initials: e.initials, color: e.color };
}

export async function registerCrewAuthRoutes(app: FastifyInstance, services: AppServices) {
  const { prisma, config } = services;
  const limiter = new RateLimiter(MAX_ATTEMPTS, ATTEMPT_WINDOW_MS);
  const ipLimiter = new RateLimiter(IP_MAX_ATTEMPTS, ATTEMPT_WINDOW_MS);
  const bruteforceMonitor = new FailureRateMonitor(GLOBAL_ALERT_THRESHOLD, GLOBAL_ALERT_WINDOW_MS);

  app.post("/api/crew/login", async (request, reply) => {
    if (!config.crewSessionSecret || !config.crewPinPepper) {
      return reply.code(503).send({ error: "Crew auth not configured" });
    }
    const parsed = LoginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid login" });
    }

    // Misconfigured-ingress guard: in prod a loopback IP with no XFF means
    // either the proxy stripped the header or we're not actually behind it.
    // Either way, the limiter can't distinguish devices — refuse rather than
    // silently sharing one bucket across the whole LAN.
    if (
      config.nodeEnv === "production" &&
      (request.ip === "127.0.0.1" || request.ip === "::1") &&
      !request.headers["x-forwarded-for"]
    ) {
      request.log.warn(
        "crew login from loopback without X-Forwarded-For; refusing to share rate-limit bucket"
      );
      return reply.code(503).send({ error: "Crew auth not configured" });
    }

    // Per-(IP, PIN-prefix) bucket. The 2-digit prefix gives per-PIN isolation
    // so one cook's fat-finger doesn't lock the next cook out, while keeping a
    // real brute-force attacker (who tries many PINs from one IP) still
    // bounded: they get MAX_ATTEMPTS per prefix per window. Only the prefix
    // (never the full PIN) is in the key, and the key never gets logged.
    const pinPrefix = parsed.data.pin.slice(0, 2);
    const limitKey = `${request.ip}:${pinPrefix}`;
    const ipKey = request.ip;
    // Locked if either the per-(IP, prefix) bucket OR the per-IP cap is exhausted.
    if (limiter.isLocked(limitKey) || ipLimiter.isLocked(ipKey)) {
      return reply.code(429).send({ error: "Too many attempts. Try again later." });
    }

    const lookup = pinLookupHash(parsed.data.pin, config.crewPinPepper);
    const employee = await prisma.inventoryEmployee.findUnique({ where: { pinLookup: lookup } });
    const ok =
      employee && employee.active ? await verifyPin(parsed.data.pin, employee.pinHash) : false;
    if (!employee || !employee.active || !ok) {
      limiter.recordFailure(limitKey);
      ipLimiter.recordFailure(ipKey);
      bruteforceMonitor.record(request.log);
      return reply.code(401).send({ error: "Invalid PIN" });
    }
    limiter.reset(limitKey);
    ipLimiter.reset(ipKey);

    const token = signCrewSession(
      { employeeId: employee.id, name: employee.name, exp: Date.now() + SESSION_TTL_MS },
      config.crewSessionSecret
    );
    return { token, employee: publicEmployee(employee) };
  });

  // Logout is best-effort. The crew session is a stateless HMAC token (no
  // server-side denylist), so it stays cryptographically verifiable until its
  // 12h TTL even after this call — true revocation is `active=false` on the
  // employee, which resolveActor enforces on every write. What we CAN do is
  // clear the cookie the browser holds, so a shared-device handoff doesn't leak
  // the previous cook's session (issue #202). Attributes must match how the
  // cookie was set client-side (path "/", lax, httpOnly) or the browser keeps a
  // stale copy; `secure` only in production so localhost http logout still clears.
  app.post("/api/crew/logout", async (_request, reply) => {
    reply.clearCookie(CREW_SESSION_COOKIE_NAME, {
      path: "/",
      sameSite: "lax",
      httpOnly: true,
      secure: config.nodeEnv === "production"
    });
    return reply.code(204).send();
  });

  app.get("/api/crew/me", async (request, reply) => {
    const session = readCrewSession(request, config);
    if (!session) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const employee = await prisma.inventoryEmployee.findUnique({ where: { id: session.employeeId } });
    if (!employee || !employee.active) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    return { employee: publicEmployee(employee) };
  });
}
