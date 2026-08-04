import { NextResponse, type NextRequest } from "next/server";
import { kdsApi } from "@/lib/kds-api";
import { handleKdsBffError } from "@/lib/kds-api/bff-error";
import { requireSession } from "@/lib/auth/require-session";
import { AdminUserCreateRequestSchema } from "@rop/contracts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SCOPE = "backoffice.api.admin.users";

export async function GET(request: NextRequest) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;

  try {
    return NextResponse.json(await kdsApi.listUsers());
  } catch (error) {
    return handleKdsBffError(SCOPE, error);
  }
}

export async function POST(request: NextRequest) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = AdminUserCreateRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "invalid_body",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message
        }))
      },
      { status: 400 }
    );
  }

  try {
    return NextResponse.json(await kdsApi.createUser(parsed.data));
  } catch (error) {
    return handleKdsBffError(SCOPE, error);
  }
}
