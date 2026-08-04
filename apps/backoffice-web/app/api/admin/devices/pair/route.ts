import { NextResponse, type NextRequest } from "next/server";
import { kdsApi } from "@/lib/kds-api";
import { handleKdsBffError } from "@/lib/kds-api/bff-error";
import { KdsDevicePairCreateRequestSchema } from "@rop/contracts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SCOPE = "backoffice.api.admin.devices.pair";

// BFF for Toast-style device pairing (ADR-0818 Phase-2b). The browser never
// holds KDS_INTERNAL_ADMIN_TOKEN or talks to kds-api directly (Iron Law #11);
// this Route Handler is the trust airlock. It mints a short-lived claim — the
// durable device token is created only when the device redeems (kds-api side).
export async function POST(request: NextRequest) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = KdsDevicePairCreateRequestSchema.safeParse(rawBody);
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
    return NextResponse.json(await kdsApi.createPairing(parsed.data));
  } catch (error) {
    return handleKdsBffError(SCOPE, error);
  }
}
