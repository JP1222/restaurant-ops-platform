import { NextResponse, type NextRequest } from "next/server";
import { PasswordChangeRequestSchema } from "@rop/contracts";
import { getSessionUser } from "@/lib/auth/session-user";
import { getBackofficeAuthService } from "@/lib/auth/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Self-service change-password (ADR-0029 P2). Session-gated: the account is
// derived from the cookie, never the body. The shared packages/auth service
// verifies the current password, breach-checks + length-validates the new one
// (HIBP), and stores it. Validation outcomes come back as a 200 discriminated
// result ({ ok:false, reason }) so the card can map them to inline UI; only
// auth/transport failures use non-2xx.
export async function POST(request: NextRequest) {
  const user = await getSessionUser(request);
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = PasswordChangeRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const result = await getBackofficeAuthService().changePassword({
    accountId: user.id,
    currentPassword: parsed.data.currentPassword,
    newPassword: parsed.data.newPassword,
  });

  return NextResponse.json(result);
}
