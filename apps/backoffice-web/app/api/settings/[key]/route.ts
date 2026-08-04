import { getCategory, isSettingKey } from "@rop/contracts";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { errorMessage, logErrorEvent } from "@/lib/ai/log";
import { findSetting } from "@/lib/settings/db";
import { getSettingsSessionUser } from "@/lib/settings/session";
import { can, webAdminRoleToRole } from "@rop/auth/rbac";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Per-key plaintext fetch for category=secret rows. The list endpoint strips
 * secret values; operators reveal via this endpoint, which audits actor + key
 * (never the value). #159 covers persisted audit_log; for now we log-event.
 */
export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ key: string }> },
): Promise<Response> {
  const user = await getSettingsSessionUser(request);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // Revealing a secret's plaintext is owner-scoped, same as the list endpoint —
  // don't let a non-owner session pull the decrypted value.
  if (!can(webAdminRoleToRole(user.role), "settings.read")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { key } = await ctx.params;
  if (!isSettingKey(key)) {
    return NextResponse.json({ error: "unknown_key" }, { status: 404 });
  }
  if (getCategory(key) !== "secret") {
    return NextResponse.json({ error: "not_a_secret" }, { status: 403 });
  }

  try {
    const row = await findSetting(key);
    let value: string | null = null;
    if (row?.value) {
      try {
        const parsed = JSON.parse(row.value);
        if (typeof parsed === "string") value = parsed;
      } catch {
        value = null;
      }
    }
    logErrorEvent({
      scope: "backoffice.api.settings.secret.reveal",
      message: "secret_revealed",
      context: { key, userId: user.id },
    });
    return NextResponse.json({ key, value });
  } catch (error) {
    logErrorEvent({
      scope: "backoffice.api.settings.secret.reveal",
      message: errorMessage(error, "reveal_failed"),
      context: { key, userId: user.id },
    });
    return NextResponse.json(
      {
        error: "decrypt_failed",
        message: "Cannot read this secret — check APP_SETTING_ENCRYPTION_KEY.",
      },
      { status: 500 },
    );
  }
}
