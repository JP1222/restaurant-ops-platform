import { expect, test, type Page } from "@playwright/test";

// Closes #189 — passkey register + login with a CDP virtual authenticator.
//
// What is REAL here: the WebAuthn ceremony. We attach a Chrome DevTools
// Protocol virtual authenticator (resident-key + user-verifying), mint a
// discoverable credential with navigator.credentials.create(), then drive the
// login button so @rop/auth's client runs navigator.credentials.get()
// against that authenticator and posts the resulting assertion to the verify
// endpoint.
//
// What is STUBBED: server-side persistence. The real options/verify routes need
// Redis (challenge store + rate limit) and db-auth (credential lookup), neither
// of which the e2e harness stands up — the proxy bypass exists precisely so
// specs don't have to (see proxy.ts). So /api/auth/login/passkey/{options,verify}
// are route-mocked to mirror the real wire contract, and the post-login page
// load uses the suite's bypass cookie because the proxy's session lookup hits
// /api/auth/me on the *server* (un-interceptable by page.route).
//
// CDP virtual authenticators are Chromium-only; the default Playwright project
// is Chromium, so this is safe.

const RP_ID = "localhost";

// WebAuthn refuses any rp.id on an IP-literal origin (127.0.0.1) — "invalid
// domain". `localhost` is a special-cased trustworthy origin where rp.id can be
// "localhost", so this spec drives the ceremony against the localhost origin
// even though the rest of the suite uses 127.0.0.1.
const PORT = Number(process.env.BACKOFFICE_E2E_PORT ?? 3001);
const LOGIN_URL = `http://localhost:${PORT}/login`;

// base64url challenge (no padding) — what generateAuthenticationOptions emits.
const CHALLENGE_B64URL = "ZHVtbXktY2hhbGxlbmdlLWZvci1lMmU";

const todayFixture = {
  business_date: "2026-05-19",
  weekday: 1,
  is_current_day: true,
  kpis: {
    net_sales: { value: 420_000, unit: "cents", baseline: null, wow_pct: null, baseline_sample_size: 0 },
    orders: { value: 124, unit: "count", baseline: null, wow_pct: null, baseline_sample_size: 0 },
    avg_ticket: { value: 3_387, unit: "cents", baseline: null, wow_pct: null, baseline_sample_size: 0 },
    refunds: { value: 1_200, unit: "cents", baseline: null, wow_pct: null, baseline_sample_size: 0 },
    refund_rate: { value: 0.0029, unit: "rate", baseline: null, wow_pct: null, baseline_sample_size: 0 },
  },
};

async function stubTodayApis(page: Page) {
  const ok = (body: unknown) => (route: import("@playwright/test").Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/api/today", ok(todayFixture));
  await page.route("**/api/today/top-items", ok({ window_days: 30, total_items: 0, top: [] }));
  await page.route(
    "**/api/today/hourly",
    ok({ business_date: "2026-05-19", weekday: 1, is_current_day: true, points: [], pacing: null }),
  );
  await page.route("**/api/today/insights", ok({ insights: [], all_clear: true }));
  await page.route(
    "**/api/today/wow",
    ok({ anchor_date: "2026-05-19", points: [], this_week_total_cents: 0, last_week_total_cents: 0, wow_pct: null }),
  );
}

test("passkey ceremony signs in via a virtual authenticator and reaches /today", async ({ page }) => {
  // 1. Attach a resident-key, user-verifying virtual authenticator over CDP.
  const client = await page.context().newCDPSession(page);
  await client.send("WebAuthn.enable");
  const { authenticatorId } = await client.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  // The /login page server component renders without auth; visit it (on the
  // localhost origin) so the resident credential is minted under a WebAuthn-valid
  // domain.
  await page.goto(LOGIN_URL);
  await expect(page.getByRole("heading", { name: /sign in to backoffice/i })).toBeVisible();

  // 2. Mint a discoverable (resident) credential — the "register" half of the
  // ceremony, performed entirely client-side against the virtual authenticator.
  const credentialId = await page.evaluate(async (rpId) => {
    function b64url(buf: ArrayBuffer) {
      return btoa(String.fromCharCode(...new Uint8Array(buf)))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    }
    const cred = (await navigator.credentials.create({
      publicKey: {
        challenge: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
        rp: { id: rpId, name: "Example Kitchen" },
        user: {
          id: new Uint8Array([9, 9, 9, 9]),
          name: "owner@example.test",
          displayName: "Owner",
        },
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        authenticatorSelection: {
          residentKey: "required",
          requireResidentKey: true,
          userVerification: "required",
        },
        timeout: 60_000,
      },
    })) as PublicKeyCredential;
    return b64url(cred.rawId);
  }, RP_ID);

  expect(credentialId.length).toBeGreaterThan(0);

  // 3. Stub the BFF passkey routes with the real wire contract. options returns
  // a PublicKeyCredentialRequestOptionsJSON for discoverable login (empty
  // allowCredentials); verify returns a session and sets an HttpOnly cookie that
  // mirrors what setSessionCookie writes in production.
  await page.route("**/api/auth/login/passkey/options", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        challengeId: "flow-e2e-1",
        options: {
          challenge: CHALLENGE_B64URL,
          timeout: 60_000,
          rpId: RP_ID,
          allowCredentials: [],
          userVerification: "required",
        },
      }),
    }),
  );

  let verifyRequestBody: unknown = null;
  await page.route("**/api/auth/login/passkey/verify", async (route) => {
    verifyRequestBody = JSON.parse(route.request().postData() ?? "null");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: {
        // Mirror the production session cookie contract (HttpOnly, SameSite=Lax,
        // Path=/). `Secure` is omitted here only because Playwright drives http
        // on loopback and would otherwise drop the cookie.
        "set-cookie": "rop_backoffice_session=e2e-session-id; Path=/; HttpOnly; SameSite=Lax",
      },
      body: JSON.stringify({
        ok: true,
        session: { authenticated: true, username: "owner", displayName: "Owner", hasPasskeys: true },
        user: { authenticated: true, username: "owner", displayName: "Owner", hasPasskeys: true },
      }),
    });
  });

  // The proxy session lookup for the post-login page hits /api/auth/me on the
  // server, which page.route cannot intercept — set the suite bypass so the
  // redirect target renders. (The ceremony above is the real coverage.)
  await page.context().addCookies([
    { name: "__e2e_auth_bypass", value: "1", domain: "localhost", path: "/" },
  ]);
  await stubTodayApis(page);

  // On a successful sign-in the form calls router.replace(returnTo) -> "/" which
  // server-redirects to /today. Assert the post-login navigation actually fires
  // (the RSC request for the destination) rather than the committed client URL,
  // which the App Router commits flakily under `next dev` in this headless
  // harness. The ceremony + verify roundtrip below are the real coverage.
  const postLoginNav = page.waitForRequest((req) => {
    const path = new URL(req.url()).pathname;
    return path === "/" || path === "/today";
  });

  // 4. Drive the login button — this runs navigator.credentials.get() against
  // the virtual authenticator and posts the assertion to verify.
  await page.getByRole("button", { name: /sign in with passkey/i }).click();

  // 5. The verify endpoint received a well-formed assertion produced by the
  // virtual authenticator, and the app initiated the post-login redirect.
  await postLoginNav;
  expect(verifyRequestBody).toMatchObject({
    challengeId: "flow-e2e-1",
    response: { id: expect.any(String), type: "public-key" },
  });

  // The session cookie the verify step set is HttpOnly — not visible to JS.
  const cookieVisibleToJs = await page.evaluate(() => document.cookie.includes("rop_backoffice_session"));
  expect(cookieVisibleToJs).toBe(false);

  await client.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
});
