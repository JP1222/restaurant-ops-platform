import { expect, test, type Page, type Route } from "@playwright/test";

// ADR-0029 P2 — the inline "Add a passkey" ceremony on the Profile panel, plus
// the resolved product decisions for that panel.
//
// What is REAL here: the WebAuthn registration ceremony. We attach a Chrome
// DevTools Protocol virtual authenticator (resident-key + user-verifying), then
// click "Add a passkey" so @rop/auth's registerPasskey() runs
// navigator.credentials.create() against that authenticator and posts the
// attestation to the verify endpoint.
//
// What is STUBBED: server-side persistence (Redis flow store + db-auth), which
// the e2e harness does not stand up — same boundary as passkey-login.spec.ts.
// The profile + passkey BFF routes are route-mocked to the real wire contract,
// and the page renders behind the suite's __e2e_auth_bypass cookie (the proxy's
// /api/auth/me session lookup runs server-side and is un-interceptable here).
//
// CDP virtual authenticators are Chromium-only (the default Playwright project),
// and WebAuthn refuses an IP-literal rp.id — so this spec drives the localhost
// origin (a special-cased trustworthy origin) rather than the 127.0.0.1 the rest
// of the suite uses.

const RP_ID = "localhost";
const PORT = Number(process.env.BACKOFFICE_E2E_PORT ?? 3001);
const PROFILE_URL = `http://localhost:${PORT}/settings/profile`;

const NEW_CREDENTIAL = {
  credentialId: "e2e-cred-id",
  createdAt: "2026-06-13T12:00:00.000Z",
  lastUsedAt: null,
  deviceType: "platform",
  backedUp: true,
  transports: ["internal"] as string[]
};

function ok(body: unknown) {
  return (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

// Attach a resident-key, user-verifying virtual authenticator over CDP.
async function attachAuthenticator(page: Page) {
  const client = await page.context().newCDPSession(page);
  await client.send("WebAuthn.enable");
  const { authenticatorId } = await client.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true
    }
  });
  return { client, authenticatorId };
}

async function bypassAuth(page: Page) {
  await page.context().addCookies([
    { name: "__e2e_auth_bypass", value: "1", domain: "localhost", path: "/" }
  ]);
}

// Profile GET — an OWNER with no passkeys yet and a usable password
// (passkeyCount drives the lockout-aware UI; here the password is the other
// method so removal is allowed).
function stubProfile(page: Page, passkeyCount: number) {
  return page.route("**/api/auth/profile", (route) => {
    if (route.request().method() !== "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) });
    }
    return ok({
      id: "acct_self",
      username: "owner",
      displayName: "Owner",
      role: "OWNER",
      passkeyCount
    })(route);
  });
}

test("profile panel: inline passkey register shows the credential; no email / change-photo affordances", async ({
  page
}) => {
  // This is the first spec to hit /settings/profile, so it absorbs the one-time
  // `next dev` cold-compile of that route — generous headroom over the base.
  test.slow();

  await bypassAuth(page);
  await stubProfile(page, 0);

  // Stateful passkey list: empty until the registration verify flips the flag,
  // after which the invalidated query re-fetch shows the new credential.
  let registered = false;
  await page.route("**/api/auth/passkeys", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return ok({ passkeys: registered ? [NEW_CREDENTIAL] : [] })(route);
  });

  const { client, authenticatorId } = await attachAuthenticator(page);

  // waitUntil:"commit" returns as soon as the route's first response commits,
  // so the long pole is the route compile (covered by test.slow()) rather than
  // the full load event; the assertions below then wait for hydration.
  await page.goto(PROFILE_URL, { waitUntil: "commit" });

  // The Profile panel rendered with the read-only Role badge.
  await expect(page.getByText("Owner · @owner")).toBeVisible();
  await expect(page.getByText("Display name")).toBeVisible();
  // Role row is present and READ-ONLY (no select/input — a Badge).
  await expect(page.getByText(/Roles are managed under Team & Access/i)).toBeVisible();

  // RESOLVED DECISION: the Email row and "Change photo" button are GONE, and
  // there is no "Sign out everywhere" affordance.
  await expect(page.getByText(/^Email$/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /change photo/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /sign out everywhere/i })).toHaveCount(0);
  await expect(page.getByText(/sign out everywhere/i)).toHaveCount(0);

  // The passkey count starts at 0.
  await expect(page.getByRole("button", { name: /0 registered/i })).toBeVisible();

  // Mock the registration ceremony BFF routes with the real wire contract:
  // options returns a bare PublicKeyCredentialCreationOptionsJSON, verify flips
  // the list flag and returns { ok, passkey }.
  await page.route("**/api/auth/passkeys/registration/options", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        rp: { id: RP_ID, name: "Example Kitchen Backoffice" },
        user: {
          // base64url of "acct_self"
          id: "YWNjdF9zZWxm",
          name: "owner",
          displayName: "Owner"
        },
        challenge: "ZHVtbXktcmVnLWNoYWxsZW5nZS1lMmU",
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 }
        ],
        timeout: 60_000,
        attestation: "none",
        excludeCredentials: [],
        authenticatorSelection: {
          residentKey: "required",
          userVerification: "required"
        }
      })
    })
  );

  let verifyRequestBody: unknown = null;
  await page.route("**/api/auth/passkeys/registration/verify", async (route) => {
    verifyRequestBody = JSON.parse(route.request().postData() ?? "null");
    registered = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, passkey: NEW_CREDENTIAL })
    });
  });

  // Drive the inline "Add a passkey" button — this runs the real WebAuthn
  // create() ceremony against the virtual authenticator.
  await page.getByRole("button", { name: /add a passkey/i }).click();

  // The verify endpoint received a well-formed attestation produced by the
  // virtual authenticator.
  await expect.poll(() => verifyRequestBody).not.toBeNull();
  expect(verifyRequestBody).toMatchObject({
    response: { id: expect.any(String), type: "public-key" }
  });

  // On success the panel toasts and the invalidated list re-fetch shows the
  // newly registered credential.
  await expect(page.getByText("Passkey added")).toBeVisible();
  await expect(page.getByText(/^platform$/i)).toBeVisible();
  await expect(page.getByText(/Added/)).toBeVisible();

  await client.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
});

test("profile panel: removing the only login method is blocked with human copy (409)", async ({
  page
}) => {
  await bypassAuth(page);
  // passwordless account with exactly one passkey -> removing it would brick it.
  await stubProfile(page, 1);
  await page.route("**/api/auth/passkeys", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return ok({ passkeys: [NEW_CREDENTIAL] })(route);
  });

  // The lockout guard: the BFF DELETE returns a 409 last_login_method with the
  // human message the UI must surface verbatim (never the raw machine code).
  const LOCKOUT_COPY =
    "This is your only sign-in method — set a password or add another passkey first.";
  await page.route(`**/api/auth/passkeys/${NEW_CREDENTIAL.credentialId}`, (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    return route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: "last_login_method", message: LOCKOUT_COPY })
    });
  });

  await page.goto(PROFILE_URL, { waitUntil: "commit" });

  // Expand the passkey list.
  await page.getByRole("button", { name: /1 registered/i }).click();
  const removeButton = page.getByRole("button", { name: /^remove$/i });
  await expect(removeButton).toBeVisible();

  await removeButton.click();

  // Human copy is surfaced (toast), and the raw machine code never leaks.
  await expect(page.getByText(LOCKOUT_COPY)).toBeVisible();
  await expect(page.getByText(/last_login_method/)).toHaveCount(0);
  // The credential is still listed — the destructive action was refused.
  await expect(page.getByText(/^platform$/i)).toBeVisible();
});
