import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  buildSessionResponse,
  clearFlowCookie,
  jsonError,
  logRouteError,
  readClientIp,
  readFlowId,
  setSessionCookie,
  validateRequestOrigin
} from "@/lib/auth/http";
import { getBackofficeSessionCookieName } from "@/lib/auth/config";
import { getBackofficeAuthService } from "@/lib/auth/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PasskeyVerifyBodySchema = z.object({
  challengeId: z.string().min(1).optional(),
  response: z.custom<AuthenticationResponseJSON>(
    (value) => typeof value === "object" && value !== null,
    "Expected an authentication response."
  )
});

export async function POST(request: NextRequest) {
  if (!validateRequestOrigin(request)) {
    return jsonError("Untrusted origin.", 403);
  }

  try {
    const body = PasskeyVerifyBodySchema.parse(await request.json());
    const auth = getBackofficeAuthService();
    const ip = readClientIp(request);
    const rateLimit = await auth.getPasskeyRateLimit(ip);
    if (rateLimit.blocked) {
      return NextResponse.json(
        {
          error: "Too many passkey attempts.",
          retryAfterSeconds: rateLimit.retryAfterSeconds
        },
        { status: 429, headers: { "retry-after": String(rateLimit.retryAfterSeconds) } }
      );
    }

    const flow = await auth.consumeWebAuthnFlow(readFlowId(request, body.challengeId));

    if (!flow || flow.flowType !== "authentication") {
      await auth.registerFailedPasskeyAttempt(ip);
      return jsonError("Authentication challenge expired.", 400);
    }

    const credentialRecord = await auth.findCredentialByCredentialId(body.response.id);
    const credential = auth.toWebAuthnCredential(credentialRecord);
    if (!credentialRecord || !credential) {
      await auth.registerFailedPasskeyAttempt(ip);
      return jsonError("Unknown passkey.", 401);
    }

    const verification = await verifyAuthenticationResponse({
      response: body.response,
      expectedChallenge: flow.challenge,
      expectedOrigin: flow.expectedOrigin,
      expectedRPID: flow.expectedRPID,
      credential,
      requireUserVerification: true
    });

    if (!verification.verified) {
      await auth.registerFailedPasskeyAttempt(ip);
      return jsonError("Passkey authentication failed.", 401);
    }

    await auth.clearPasskeyAttempts(ip);
    await auth.updateCredentialUsage(credentialRecord.credentialId, {
      counter: verification.authenticationInfo.newCounter,
      deviceType: verification.authenticationInfo.credentialDeviceType,
      backedUp: verification.authenticationInfo.credentialBackedUp,
      lastUsedAt: new Date()
    });

    // GH #476: invalidate any pre-existing (possibly fixated) session before
    // minting the new one (see password login route). No-op without a cookie.
    await auth.destroySession(request.cookies.get(getBackofficeSessionCookieName())?.value);
    const { sessionId } = await auth.createSession(credentialRecord.account);
    const session = buildSessionResponse({
      username: credentialRecord.account.username,
      displayName: credentialRecord.account.displayName,
      hasPasskeys: (await auth.getPasskeyCount(credentialRecord.account.id)) > 0
    });
    const success = NextResponse.json({
      ok: true,
      session,
      user: session
    });
    clearFlowCookie(success, auth);
    setSessionCookie(success, auth, sessionId);
    return success;
  } catch (error) {
    if (error instanceof z.ZodError) {
      return jsonError("Invalid passkey verification request.", 400);
    }

    logRouteError("backoffice.auth.login.passkey.verify", error);
    return jsonError("Passkey sign-in failed.", 500);
  }
}
