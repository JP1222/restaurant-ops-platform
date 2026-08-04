import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  buildSessionResponse,
  clearFlowCookie,
  jsonError,
  logRouteError,
  readClientIp,
  setSessionCookie,
  validateRequestOrigin
} from "@/lib/auth/http";
import { getBackofficeSessionCookieName } from "@/lib/auth/config";
import { getBackofficeAuthService } from "@/lib/auth/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PasswordLoginBodySchema = z.object({
  username: z.string().trim().min(1),
  password: z.string().min(1)
});

export async function POST(request: NextRequest) {
  if (!validateRequestOrigin(request)) {
    return jsonError("Untrusted origin.", 403);
  }

  try {
    const body = PasswordLoginBodySchema.parse(await request.json());
    const auth = getBackofficeAuthService();
    const ip = readClientIp(request);
    const rateLimit = await auth.getPasswordRateLimit(ip, body.username);
    if (rateLimit.blocked) {
      return NextResponse.json(
        {
          error: "Too many login attempts.",
          retryAfterSeconds: rateLimit.retryAfterSeconds
        },
        { status: 429 }
      );
    }

    const account = await auth.verifyPassword(body.username, body.password);
    if (!account) {
      const failure = await auth.registerFailedPasswordAttempt(ip, body.username);
      return NextResponse.json(
        failure.blocked
          ? {
              error: "Too many login attempts.",
              retryAfterSeconds: failure.retryAfterSeconds
            }
          : {
              error: "Invalid username or password."
            },
        { status: failure.blocked ? 429 : 401 }
      );
    }

    await auth.clearPasswordAttempts(ip, body.username);
    // GH #476: destroy any pre-existing (possibly fixated) session before minting
    // a new one. Sessions are keyed by sessionId only, so an attacker-planted id
    // would otherwise survive the victim's login. No-op without a session cookie.
    await auth.destroySession(request.cookies.get(getBackofficeSessionCookieName())?.value);
    const { sessionId } = await auth.createSession(account);
    const session = buildSessionResponse({
      username: account.username,
      displayName: account.displayName,
      hasPasskeys: (await auth.getPasskeyCount(account.id)) > 0
    });

    const response = NextResponse.json({
      ok: true,
      session,
      user: session
    });
    setSessionCookie(response, auth, sessionId);
    clearFlowCookie(response, auth);
    return response;
  } catch (error) {
    if (error instanceof z.ZodError) {
      return jsonError("Invalid login request.", 400);
    }

    logRouteError("backoffice.auth.login.password", error);
    return jsonError("Sign-in failed.", 500);
  }
}
