import { NextResponse, type NextRequest } from "next/server";
import { requireSession } from "@/lib/auth/require-session";
import { getServerEnv } from "@/lib/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface ProbeDef {
  app: string;
  label: string;
  url: string;
  // Some endpoints expect a Bearer; this is computed at request time so the
  // env-bound secret is never bundled in client JS.
  authHeader?: () => string | undefined;
}

interface ProbeResult {
  app: string;
  label: string;
  url: string;
  status: "healthy" | "unhealthy" | "unknown";
  httpStatus: number | null;
  latencyMs: number | null;
  error: string | null;
  checkedAt: string;
}

const PROBE_TIMEOUT_MS = 4000;

async function probe(def: ProbeDef): Promise<ProbeResult> {
  const checkedAt = new Date().toISOString();
  const headers: Record<string, string> = { Accept: "application/json" };
  const bearer = def.authHeader?.();
  if (bearer) headers.Authorization = `Bearer ${bearer}`;

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  const start = Date.now();
  try {
    const res = await fetch(def.url, {
      headers,
      cache: "no-store",
      signal: ctrl.signal,
      redirect: "manual",
    });
    const latency = Date.now() - start;
    // Treat 2xx + 3xx as up (login flows commonly redirect). kds-api /api/health
    // and analytics-api /healthz both return 200; backoffice /login returns 200.
    const ok = res.status >= 200 && res.status < 400;
    return {
      app: def.app,
      label: def.label,
      url: def.url,
      status: ok ? "healthy" : "unhealthy",
      httpStatus: res.status,
      latencyMs: latency,
      error: null,
      checkedAt,
    };
  } catch (error) {
    const latency = Date.now() - start;
    return {
      app: def.app,
      label: def.label,
      url: def.url,
      status: "unhealthy",
      httpStatus: null,
      latencyMs: latency,
      error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      checkedAt,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function buildProbes(): ProbeDef[] {
  const env = getServerEnv();
  const probes: ProbeDef[] = [
    {
      app: "analytics-api",
      label: "Analytics API",
      url: `${env.INTERNAL_ANALYTICS_API_URL.replace(/\/$/, "")}/healthz`,
      authHeader: () => undefined,
    },
    {
      app: "backoffice-web",
      // Self-probe: shorter network path than the public URL. Hits the public
      // /login page (PUBLIC_PAGE_PATHS in proxy.ts) for a 200 smoke test that the
      // container can render its own pages. NOT /api/auth/me — that is auth-gated
      // and 401s without a session cookie, which the probe reads as unhealthy.
      label: "Backoffice (self)",
      url: "http://127.0.0.1:3001/login",
      authHeader: () => undefined,
    },
    // The remaining stacks have no BFF env var, but they share rop-net
    // with backoffice, so the BFF reaches them by service name. Each path mirrors
    // that stack's compose healthcheck (a verified-200 liveness route).
    { app: "kds-web", label: "KDS Web", url: "http://kds-web:3000/login", authHeader: () => undefined },
    { app: "inventory-api", label: "Inventory API", url: "http://inventory-api:4100/api/health", authHeader: () => undefined },
    { app: "crm-api", label: "CRM API", url: "http://crm-api:4200/api/health", authHeader: () => undefined },
    { app: "crew-web", label: "Crew Web", url: "http://crew-web:3003/", authHeader: () => undefined },
    { app: "order-web", label: "Order Web", url: "http://order-web:3004/", authHeader: () => undefined },
    { app: "legal-site", label: "Legal Site", url: "http://legal-site/", authHeader: () => undefined },
    { app: "marketing-site", label: "Marketing Site", url: "http://marketing-site/", authHeader: () => undefined },
  ];
  if (env.INTERNAL_KDS_API_URL) {
    probes.push({
      app: "kds-api",
      label: "KDS API",
      // kds-api's Fastify liveness route is /api/health (always 200 when up); it
      // has no /healthz (that path 404s). /api/ready exists too but 503s on a
      // dependency blip — liveness is the right signal for "container is serving".
      url: `${env.INTERNAL_KDS_API_URL.replace(/\/$/, "")}/api/health`,
      authHeader: () => undefined,
    });
  }
  return probes;
}

export async function GET(request: NextRequest) {
  const unauth = await requireSession(request);
  if (unauth) return unauth;
  const probes = buildProbes();
  const results = await Promise.all(probes.map(probe));
  // overall: healthy iff all healthy.
  const overall = results.every((r) => r.status === "healthy")
    ? "healthy"
    : results.some((r) => r.status === "healthy")
      ? "degraded"
      : "unhealthy";
  return NextResponse.json({ overall, services: results, checkedAt: new Date().toISOString() });
}
