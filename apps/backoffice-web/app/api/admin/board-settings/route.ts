import { NextResponse, type NextRequest } from "next/server";
import { kdsApi } from "@/lib/kds-api";
import { handleKdsBffError } from "@/lib/kds-api/bff-error";
import { KitchenBoardSettingsSchema } from "@rop/contracts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SCOPE = "backoffice.api.admin.board-settings";

export async function GET(request: NextRequest) {
  const merchantId = request.nextUrl.searchParams.get("merchantId") ?? undefined;
  try {
    return NextResponse.json(await kdsApi.getBoardSettings(merchantId));
  } catch (error) {
    return handleKdsBffError(SCOPE, error);
  }
}

export async function PUT(request: NextRequest) {
  const merchantId = request.nextUrl.searchParams.get("merchantId") ?? undefined;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = KitchenBoardSettingsSchema.safeParse(rawBody);
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
    return NextResponse.json(await kdsApi.updateBoardSettings(parsed.data, merchantId));
  } catch (error) {
    return handleKdsBffError(SCOPE, error);
  }
}
