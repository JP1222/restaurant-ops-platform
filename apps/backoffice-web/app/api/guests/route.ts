import { NextResponse } from "next/server";
import { crmApi, CrmApiError, CrmApiNotConfiguredError } from "@/lib/crm-api/client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const payload = await crmApi.cohorts();
    return NextResponse.json(payload);
  } catch (error) {
    if (error instanceof CrmApiNotConfiguredError) {
      // crm-api isn't wired into this env yet — the page renders a "not connected"
      // empty state rather than an error.
      return NextResponse.json({ error: "not_connected" }, { status: 503 });
    }
    if (error instanceof CrmApiError) {
      return NextResponse.json({ error: "crm_api_error" }, { status: error.status });
    }
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
