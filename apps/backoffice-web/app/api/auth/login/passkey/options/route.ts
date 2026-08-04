import { generateAuthenticationOptions } from "@simplewebauthn/server";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getWebAuthnRpId, WEBAUTHN_TIMEOUT_MS } from "@rop/auth/server";
import {
  jsonError,
  logRouteError,
  readClientIp,
  setFlowCookie,
  validateRequestOrigin
} from "@/lib/auth/http";
import { getBackofficeAuthConfig } from "@/lib/auth/config";
import { getBackofficeAuthService } from "@/lib/auth/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PasskeyOptionsBodySchema = z.object({
  username: z.string().trim().min(1).optional()
});

export async function POST(request: NextRequest) {
  if (!validateRequestOrigin(request)) {
    return jsonError("Untrusted origin.", 403);
  }

  try {
    PasskeyOptionsBodySchema.parse(await request.json().catch(() => ({})));
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

    const config = getBackofficeAuthConfig();
    const options = await generateAuthenticationOptions({
      rpID: getWebAuthnRpId(config),
      allowCredentials: [],
      userVerification: "required",
      timeout: WEBAUTHN_TIMEOUT_MS
    });

    const challengeId = await auth.createWebAuthnFlow({
      challenge: options.challenge,
      flowType: "authentication"
    });
    const response = NextResponse.json({
      options,
      challengeId
    });
    setFlowCookie(response, auth, challengeId);
    return response;
  } catch (error) {
    if (error instanceof z.ZodError) {
      return jsonError("Invalid passkey request.", 400);
    }

    logRouteError("backoffice.auth.login.passkey.options", error);
    return jsonError("Passkey sign-in failed.", 500);
  }
}
