import { NextResponse, type NextRequest } from "next/server";
import { kdsApi } from "@/lib/kds-api";
import { handleKdsBffError } from "@/lib/kds-api/bff-error";
import { requireSession } from "@/lib/auth/require-session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SCOPE = "backoffice.api.admin.users.passkeys.delete";

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ userId: string; credentialId: string }> }
) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;

  const { userId, credentialId } = await context.params;
  if (!userId || !credentialId) {
    return NextResponse.json({ error: "missing_path_params" }, { status: 400 });
  }
  try {
    return NextResponse.json(await kdsApi.revokeUserPasskey(userId, credentialId));
  } catch (error) {
    return handleKdsBffError(SCOPE, error);
  }
}
