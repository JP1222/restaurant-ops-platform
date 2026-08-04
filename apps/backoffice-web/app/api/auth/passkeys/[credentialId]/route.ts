import { NextResponse, type NextRequest } from "next/server";
import { jsonError, logRouteError, validateRequestOrigin } from "@/lib/auth/http";
import { getBackofficeAuthService } from "@/lib/auth/service";
import { getSessionUser } from "@/lib/auth/session-user";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Self-service passkey removal (ADR-0029 P2). Session-scoped: only the session
// account's own credentials. Goes through the SHARED transactional guard in
// packages/auth (deletePasskeyGuarded): one Serializable transaction checks
// existence, re-reads the lockout invariant (an account must keep >= 1 usable
// login method), and deletes. Existence is checked FIRST, so a stale credential
// id is a 404 (not a 409 masking it, review LOCKOUT-03); removing the last
// passkey of a password-less account is refused with 409 last_login_method.
// Recovery is an OWNER-issued reset setup-link.
export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ credentialId: string }> }
) {
  if (!validateRequestOrigin(request)) {
    return jsonError("Untrusted origin.", 403);
  }

  const user = await getSessionUser(request);
  if (!user) {
    return jsonError("Authentication required.", 401);
  }

  const { credentialId } = await context.params;
  if (!credentialId) {
    return jsonError("Missing credential id.", 400);
  }

  try {
    const auth = getBackofficeAuthService();
    const result = await auth.deletePasskeyGuarded(user.id, credentialId);
    if (!result.ok) {
      if (result.reason === "not_found") {
        return jsonError("Passkey not found.", 404);
      }
      return NextResponse.json(
        {
          error: "last_login_method",
          message:
            "This is your only sign-in method — set a password or add another passkey first."
        },
        { status: 409 }
      );
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    logRouteError("backoffice.auth.passkeys.delete", error);
    return jsonError("Could not remove passkey.", 500);
  }
}
