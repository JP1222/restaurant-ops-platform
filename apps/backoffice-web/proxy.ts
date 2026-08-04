import { NextResponse, type NextRequest } from "next/server";

const PUBLIC_PAGE_PATHS = ["/login", "/set-password"];
const PUBLIC_API_PATHS = ["/api/auth"];

function isPublicPath(pathname: string) {
  return (
    PUBLIC_PAGE_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`)) ||
    PUBLIC_API_PATHS.some((path) => pathname.startsWith(path))
  );
}

// Trusted internal service-to-service callers of the AI proxy routes (crew-web's Floor
// BFF — the Floor app has no AI provider of its own, ADR-0538). crew-web forwards three
// internal-token calls: invoice-scan → receipt-parse, plus the cosmetic emoji-suggest and
// match-suggest assists. A valid INTERNAL_AI_TOKEN bearer skips the operator-session gate
// at the edge so the request can reach the route handler, which re-checks the same token
// (defense in depth) and still applies the kill-switch + rate-limit. A wrong / missing
// token falls through to the normal session check (→ 401).
const INTERNAL_AI_PATHS = [
  "/api/inventory/receipt-parse",
  "/api/inventory/emoji-suggest",
  "/api/inventory/match-suggest"
];

function isInternalAiCall(request: NextRequest, pathname: string): boolean {
  if (!INTERNAL_AI_PATHS.includes(pathname)) {
    return false;
  }
  const token = process.env.INTERNAL_AI_TOKEN;
  return Boolean(token) && request.headers.get("authorization") === `Bearer ${token}`;
}

// The AI price-refresh cron (.github/workflows/ai-prices-refresh.yml) POSTs to the price
// endpoint with a bearer token instead of an operator session — same edge exemption as the
// internal AI calls above, so the request can reach the route handler (which re-checks the
// same token, defense in depth). Dormant until AI_PRICES_REFRESH_TOKEN is set; a wrong /
// missing token falls through to the normal session check (→ 401).
function isPriceRefreshCron(request: NextRequest, pathname: string): boolean {
  if (pathname !== "/api/ai/prices/refresh") {
    return false;
  }
  const token = process.env.AI_PRICES_REFRESH_TOKEN;
  return Boolean(token) && request.headers.get("authorization") === `Bearer ${token}`;
}

function redirectToLogin(request: NextRequest) {
  const url = new URL("/login", request.url);
  if (request.nextUrl.pathname !== "/") {
    url.searchParams.set("from", `${request.nextUrl.pathname}${request.nextUrl.search}`);
  }
  return NextResponse.redirect(url);
}

function unauthenticatedResponse(request: NextRequest) {
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "unauthenticated", message: "Sign in required." },
      { status: 401 }
    );
  }

  return redirectToLogin(request);
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  if (isInternalAiCall(request, pathname)) {
    return NextResponse.next();
  }

  if (isPriceRefreshCron(request, pathname)) {
    return NextResponse.next();
  }

  // Playwright e2e opt-out: when the env-gated bypass is enabled in a
  // non-production environment AND the request carries the bypass cookie,
  // skip session checks so specs can route-intercept BFF responses without
  // standing up Redis + a real WebAuthn flow. Opt-in is per-test (cookie)
  // so unauthenticated specs (auth.spec.ts) still exercise the real proxy.
  if (
    process.env.NODE_ENV !== "production" &&
    process.env.BACKOFFICE_E2E_AUTH_BYPASS === "true" &&
    request.cookies.get("__e2e_auth_bypass")?.value === "1"
  ) {
    return NextResponse.next();
  }

  const cookieName = process.env.BACKOFFICE_SESSION_COOKIE_NAME ?? "rop_backoffice_session";
  if (!request.cookies.get(cookieName)?.value) {
    return unauthenticatedResponse(request);
  }

  // Self-fetch via localhost (not request.url) — request.url is the public URL
  // that hairpins through Traefik with TLS; Node fetch from inside the same
  // container fails the TLS handshake (ERR_SSL_WRONG_VERSION_NUMBER) and either
  // 500s or loops to /login. Localhost loopback is HTTP, same Node process.
  const internalPort = process.env.PORT ?? "3001";
  const meUrl = `http://127.0.0.1:${internalPort}/api/auth/me`;
  let sessionResponse: Response;
  try {
    sessionResponse = await fetch(meUrl, {
      cache: "no-store",
      headers: {
        cookie: request.headers.get("cookie") ?? "",
        host: request.headers.get("host") ?? ""
      }
    });
  } catch {
    return unauthenticatedResponse(request);
  }

  if (!sessionResponse.ok) {
    return unauthenticatedResponse(request);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"]
};
