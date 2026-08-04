import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { SquareConnectRequestSchema } from "@rop/contracts";
import { errorMessage, logErrorEvent } from "@/lib/ai/log";
import { kdsApi, KdsApiError, KdsApiNotConfiguredError } from "@/lib/kds-api";
import { getSettingsSessionUser } from "@/lib/settings/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REQUIRED_ROLE = "ADMIN";

// Thin proxy to kds-api POST /api/square/connect. Persists one PosAccount +
// one PosStore per active Square location. Returns stores[] so the wizard can
// offer a location picker, then bind the selected posStoreId to the Location
// created in step 1 via the existing /api/locations/[id]/bind route.
export async function POST(request: NextRequest): Promise<Response> {
  const user = await getSettingsSessionUser(request);
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (user.role !== REQUIRED_ROLE) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = SquareConnectRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  try {
    const result = await kdsApi.connectSquare(parsed.data);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof KdsApiNotConfiguredError) {
      return NextResponse.json({ error: "admin_not_configured" }, { status: 503 });
    }
    if (error instanceof KdsApiError) {
      let kind = "upstream";
      try {
        const upstream = JSON.parse(error.bodyText) as unknown;
        if (typeof upstream === "object" && upstream !== null && "error" in upstream) {
          kind = String((upstream as Record<string, unknown>)["error"]);
        }
      } catch {
        // bodyText not JSON — use generic upstream
      }
      const status = error.status >= 400 && error.status < 600 ? error.status : 502;
      logErrorEvent({
        scope: "backoffice.api.square.connect",
        message: `upstream ${error.status}: ${kind}`,
      });
      return NextResponse.json({ error: kind }, { status });
    }
    logErrorEvent({
      scope: "backoffice.api.square.connect",
      message: errorMessage(error, "internal"),
    });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
