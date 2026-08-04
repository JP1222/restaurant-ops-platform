import { NextResponse, type NextRequest } from "next/server";
import { PasswordSetRequestSchema } from "@rop/contracts";
import { kdsApi } from "@/lib/kds-api";
import { handleKdsBffError } from "@/lib/kds-api/bff-error";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SCOPE = "backoffice.api.auth.password.set";

// Public token-gated set-password redemption (ADR-0029 P2). The one-time setup
// token in the body is the credential. Proxies to the kds-api endpoint (which
// owns the token's Redis); kds-api returns a 200 discriminated result that we
// pass through so the page maps { reason } to inline UI.
export async function POST(request: NextRequest) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = PasswordSetRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  try {
    return NextResponse.json(await kdsApi.setPassword(parsed.data));
  } catch (error) {
    return handleKdsBffError(SCOPE, error);
  }
}
