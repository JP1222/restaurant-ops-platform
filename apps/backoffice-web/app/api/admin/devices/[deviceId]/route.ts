import { NextResponse } from "next/server";
import { kdsApi } from "@/lib/kds-api";
import { handleKdsBffError } from "@/lib/kds-api/bff-error";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SCOPE = "backoffice.api.admin.devices.delete";

export async function DELETE(_request: Request, context: { params: Promise<{ deviceId: string }> }) {
  const { deviceId } = await context.params;
  if (!deviceId) {
    return NextResponse.json({ error: "missing_device_id" }, { status: 400 });
  }

  try {
    return NextResponse.json(await kdsApi.revokeDevice(deviceId));
  } catch (error) {
    return handleKdsBffError(SCOPE, error);
  }
}
