import { verifyRegistrationResponse } from "@simplewebauthn/server";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { clearFlowCookie, jsonError, logRouteError, readFlowId, validateRequestOrigin } from "@/lib/auth/http";
import { saveSelfPasskey } from "@/lib/auth/profile";
import { getBackofficeAuthService } from "@/lib/auth/service";
import { getSessionUser } from "@/lib/auth/session-user";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RegistrationVerifyBodySchema = z.object({
  challengeId: z.string().min(1).optional(),
  response: z.custom<RegistrationResponseJSON>(
    (value) => typeof value === "object" && value !== null,
    "Expected a registration response."
  )
});

// Self-service passkey registration — step 2 (ADR-0029 P2). Session-gated; the
// account is the cookie's, never the body's. Consumes the single-use challenge
// stored by the options route, verifies it, and persists the credential for the
// session account. Returns { ok:true, passkey } so the shared client helper can
// append it to the UI list; a duplicate credential is a 409.
export async function POST(request: NextRequest) {
  if (!validateRequestOrigin(request)) {
    return jsonError("Untrusted origin.", 403);
  }

  const user = await getSessionUser(request);
  if (!user) {
    return jsonError("Authentication required.", 401);
  }

  try {
    const body = RegistrationVerifyBodySchema.parse(await request.json());
    const auth = getBackofficeAuthService();
    const flow = await auth.consumeWebAuthnFlow(readFlowId(request, body.challengeId));

    if (!flow || flow.flowType !== "registration" || flow.accountId !== user.id) {
      const expired = jsonError("Registration challenge expired.", 400);
      clearFlowCookie(expired, auth);
      return expired;
    }

    const verification = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge: flow.challenge,
      expectedOrigin: flow.expectedOrigin,
      expectedRPID: flow.expectedRPID,
      requireUserVerification: true
    });

    if (!verification.verified || !verification.registrationInfo) {
      const failed = jsonError("Passkey registration could not be verified.", 400);
      clearFlowCookie(failed, auth);
      return failed;
    }

    const result = await saveSelfPasskey({
      accountId: user.id,
      credentialId: verification.registrationInfo.credential.id,
      publicKey: verification.registrationInfo.credential.publicKey,
      counter: verification.registrationInfo.credential.counter,
      deviceType: verification.registrationInfo.credentialDeviceType,
      backedUp: verification.registrationInfo.credentialBackedUp,
      transports: body.response.response.transports ?? []
    });

    if (!result.ok) {
      const conflict = jsonError("Passkey already registered.", 409);
      clearFlowCookie(conflict, auth);
      return conflict;
    }

    const success = NextResponse.json({ ok: true, passkey: result.passkey });
    clearFlowCookie(success, auth);
    return success;
  } catch (error) {
    if (error instanceof z.ZodError) {
      return jsonError("Invalid passkey verification request.", 400);
    }

    logRouteError("backoffice.auth.passkeys.registration.verify", error);
    return jsonError("Passkey registration failed.", 500);
  }
}
