import type { FastifyReply, FastifyRequest } from "fastify";

// The operator identity for per-operator state/prefs travels in the
// `x-operator-id` header, stamped by the backoffice BFF from its authenticated
// session. The bearer token authenticates the BFF; this header says *which*
// operator the call is on behalf of. notifications-api never imports db-auth —
// it trusts the id the authenticated BFF supplies (Iron Law 1/3).
export function operatorId(request: FastifyRequest): string | null {
  const value = request.headers["x-operator-id"];
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  return null;
}

/** Resolve the operator id or 400 — returns null after replying when absent. */
export function requireOperator(request: FastifyRequest, reply: FastifyReply): string | null {
  const op = operatorId(request);
  if (!op) {
    reply.code(400).send({ error: "x-operator-id header required" });
    return null;
  }
  return op;
}

// The operator's backoffice role, stamped by the trusted BFF from its session
// (`x-operator-role`). notifications-api never resolves roles itself (Iron Law
// 1/3) — it trusts the authenticated BFF's claim, exactly like `x-operator-id`.
// The authoritative RBAC check (`can(role, …)`) lives in the BFF; this server-side
// gate (AGENTS rule 4) is the coarse "privileged operator" backstop + audit value.
const MANAGER_ROLES = new Set(["OWNER", "MANAGER", "ADMIN"]);

export function operatorRole(request: FastifyRequest): string | null {
  const value = request.headers["x-operator-role"];
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  return null;
}

/**
 * Resolve a manager-or-above operator role or 403 — returns null after replying.
 * The mutating suggested-action endpoint is manager-gated. Every WebAdminRole
 * issued today (OWNER / MANAGER / legacy ADMIN, which maps to OWNER) qualifies, so
 * this rejects an absent or unrecognized role and is forward-compatible with a
 * future non-privileged role (e.g. STAFF).
 */
export function requireManagerRole(request: FastifyRequest, reply: FastifyReply): string | null {
  const role = operatorRole(request);
  if (!role || !MANAGER_ROLES.has(role)) {
    reply.code(403).send({ error: "manager role required" });
    return null;
  }
  return role;
}
