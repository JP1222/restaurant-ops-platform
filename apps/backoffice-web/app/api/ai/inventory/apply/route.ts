import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { getAiSessionUser } from "@/lib/ai/session";
import {
  AiInventoryActionSchema,
  buildCountBody,
  buildReceiveBody,
  buildWasteBody,
  resolveInventoryItem,
} from "@/lib/ai/inventory-apply";
import { statusOf } from "@/lib/inventory/helpers";
import { handleInventoryApiError, inventoryApi } from "@/lib/inventory-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Write BFF for the AI inventory tools (record_receiving / record_waste /
 * set_inventory_count). Only reached AFTER the operator approves the tool call in
 * the chat UI (SDK tool approval). Resolves the proposed item name to one active
 * item, applies the change via the existing idempotent inventory-api write paths,
 * and reports authoritative on-hand before/after. A resolution miss is a 200
 * structured non-write result so the model can ask the operator to clarify.
 */
export async function POST(request: NextRequest): Promise<Response> {
  const user = await getAiSessionUser(request);
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = AiInventoryActionSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const action = parsed.data;
  const who = user.username || user.id || "ai-assistant";

  try {
    const dataset = await inventoryApi.getDataset();
    const resolved = resolveInventoryItem(dataset, action.item);
    if (!resolved.ok) {
      return NextResponse.json({
        ok: false,
        error: resolved.error,
        query: action.item,
        ...(resolved.error === "ambiguous" ? { candidates: resolved.candidates } : {}),
      });
    }

    const item = resolved.item;
    const onHandBefore = item.on_hand;

    if (action.action === "receive") {
      await inventoryApi.receiveAdHoc(
        buildReceiveBody(item, action.quantity, who, action.idempotency_key, action.note),
      );
    } else if (action.action === "waste") {
      await inventoryApi.recordWaste(
        buildWasteBody(item, action.quantity, action.reason, who, action.idempotency_key, action.note),
      );
    } else {
      await inventoryApi.applyCounts(
        buildCountBody(item, action.counted_quantity, who, action.idempotency_key, action.note),
      );
    }

    // Re-read for the authoritative post-write on-hand (also reflects an
    // idempotent replay correctly: a duplicate key is a no-op, so on-hand holds).
    const after = await inventoryApi.getDataset();
    const updated = after.items.find((it) => it.id === item.id) ?? item;

    return NextResponse.json({
      ok: true,
      action: action.action,
      item: { name: item.name, sku: item.sku, unit: item.unit },
      on_hand_before: onHandBefore,
      on_hand_after: updated.on_hand,
      status: statusOf(updated),
    });
  } catch (error) {
    return handleInventoryApiError(error, "backoffice.api.ai.inventory.apply");
  }
}
