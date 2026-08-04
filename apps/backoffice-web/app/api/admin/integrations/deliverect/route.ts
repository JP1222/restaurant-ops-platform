import { NextResponse, type NextRequest } from "next/server";
import { kdsApi } from "@/lib/kds-api";
import { KdsApiError } from "@/lib/kds-api/client";
import { handleKdsBffError } from "@/lib/kds-api/bff-error";
import { DeliverectIntegrationUpdateRequestSchema } from "@rop/contracts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SCOPE = "backoffice.api.admin.integrations.deliverect";

export async function GET() {
  try {
    const upstream = await kdsApi.getDeliverectIntegration();
    return NextResponse.json({ config: upstream.config });
  } catch (error) {
    // Pass through 404 (not yet configured) as a clean BFF 404 so the editor
    // can render an empty-state form rather than an error banner.
    if (error instanceof KdsApiError && error.status === 404) {
      return NextResponse.json({ error: "not_configured" }, { status: 404 });
    }
    return handleKdsBffError(SCOPE, error);
  }
}

export async function PUT(request: NextRequest) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = DeliverectIntegrationUpdateRequestSchema.safeParse(rawBody);
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
    const upstream = await kdsApi.updateDeliverectIntegration(parsed.data);
    return NextResponse.json({ config: upstream.config });
  } catch (error) {
    return handleKdsBffError(SCOPE, error);
  }
}

export async function DELETE() {
  try {
    await kdsApi.deleteDeliverectIntegration();
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (error instanceof KdsApiError && error.status === 404) {
      return NextResponse.json({ error: "not_configured" }, { status: 404 });
    }
    return handleKdsBffError(SCOPE, error);
  }
}
