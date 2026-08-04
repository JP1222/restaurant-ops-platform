import { generateRegistrationOptions } from "@simplewebauthn/server";
import { NextResponse, type NextRequest } from "next/server";
import { getWebAuthnRpId, getWebAuthnRpName, WEBAUTHN_TIMEOUT_MS } from "@rop/auth/server";
import { getBackofficeAuthConfig } from "@/lib/auth/config";
import { jsonError, logRouteError, setFlowCookie, validateRequestOrigin } from "@/lib/auth/http";
import { getBackofficeAuthService } from "@/lib/auth/service";
import { getSessionUser } from "@/lib/auth/session-user";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Self-service passkey registration — step 1 (ADR-0029 P2). Session-gated: the
// account is derived from the cookie, never the body. Mirrors the kds-api
// self-service flow (apps/kds-api/src/routes/auth.ts) but on a backoffice
// session. residentKey + userVerification are both "required". The challenge
// is stored server-side in the same Redis flow store / flow cookie the passkey
// login route uses, scoped (accountId) to the session account. The bare
// PublicKeyCredentialCreationOptionsJSON is returned so the shared
// @rop/auth/client registerPasskey() helper can consume it directly.
export async function POST(request: NextRequest) {
  if (!validateRequestOrigin(request)) {
    return jsonError("Untrusted origin.", 403);
  }

  const user = await getSessionUser(request);
  if (!user) {
    return jsonError("Authentication required.", 401);
  }

  try {
    const auth = getBackofficeAuthService();
    const config = getBackofficeAuthConfig();
    const existing = await auth.listPasskeys(user.id);

    const options = await generateRegistrationOptions({
      rpName: getWebAuthnRpName(config),
      rpID: getWebAuthnRpId(config),
      userName: user.username,
      userID: new TextEncoder().encode(user.id),
      userDisplayName: user.displayName,
      attestationType: "none",
      timeout: WEBAUTHN_TIMEOUT_MS,
      excludeCredentials: existing.map((passkey) => ({
        id: passkey.credentialId,
        transports: passkey.transports
      })),
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required"
      }
    });

    const flowId = await auth.createWebAuthnFlow({
      challenge: options.challenge,
      flowType: "registration",
      accountId: user.id
    });
    const response = NextResponse.json(options);
    setFlowCookie(response, auth, flowId);
    return response;
  } catch (error) {
    logRouteError("backoffice.auth.passkeys.registration.options", error);
    return jsonError("Passkey registration failed.", 500);
  }
}
