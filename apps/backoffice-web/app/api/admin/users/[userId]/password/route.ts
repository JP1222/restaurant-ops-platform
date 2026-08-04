import { NextResponse, type NextRequest } from "next/server";
import { kdsApi } from "@/lib/kds-api";
import { handleKdsBffError } from "@/lib/kds-api/bff-error";
import { requireSession } from "@/lib/auth/require-session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SCOPE = "backoffice.api.admin.users.password";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ userId: string }> }
) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;

  const { userId } = await context.params;
  if (!userId) {
    return NextResponse.json({ error: "missing_user_id" }, { status: 400 });
  }
  try {
    return NextResponse.json(await kdsApi.resetUserPassword(userId));
  } catch (error) {
    return handleKdsBffError(SCOPE, error);
  }
}
