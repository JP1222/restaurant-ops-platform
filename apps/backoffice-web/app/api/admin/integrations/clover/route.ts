import { NextResponse } from "next/server";
import { kdsApi } from "@/lib/kds-api";
import { handleKdsBffError } from "@/lib/kds-api/bff-error";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SCOPE = "backoffice.api.admin.integrations.clover";

export async function GET() {
  try {
    return NextResponse.json(await kdsApi.getCloverIntegration());
  } catch (error) {
    return handleKdsBffError(SCOPE, error);
  }
}
