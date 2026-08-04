import { NextResponse } from "next/server";
import { OrderMenuResponseSchema } from "@rop/contracts";
import { orderApiUrl } from "@/lib/server/order-api";
import { centsToDollars } from "@/lib/money";
import type { Menu } from "@/lib/types";

// Menu changes per request (the merchant's live Clover catalog, cached 60s
// upstream); never let Next statically cache this handler.
export const dynamic = "force-dynamic";

/**
 * GET /api/order/menu — BFF.
 *
 * Forwards to kds-api's public menu endpoint (the merchant's live Clover
 * catalog), validates it against the integer-cents contract, and maps it to
 * the dollar `Menu` shape the order-web UI speaks. The browser never sees the
 * kds-api host or the cents wire format.
 *
 * UI-only fields (tagline / number / tags / flavor) are not part of the
 * catalog contract — the UI infers (flavor, signature number) or omits them,
 * so the mapping just carries the contract fields + converts cents → dollars.
 */
export async function GET() {
  let upstream: Response;
  try {
    upstream = await fetch(orderApiUrl("/api/order/menu"), {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
  } catch {
    return NextResponse.json({ error: "Menu is temporarily unavailable." }, { status: 502 });
  }

  if (!upstream.ok) {
    // Pass through "not configured yet" (503) distinctly from a bad gateway.
    return NextResponse.json(
      { error: "Menu is temporarily unavailable." },
      { status: upstream.status === 503 ? 503 : 502 },
    );
  }

  const parsed = OrderMenuResponseSchema.safeParse(
    await upstream.json().catch(() => null),
  );
  if (!parsed.success) {
    return NextResponse.json({ error: "Menu is temporarily unavailable." }, { status: 502 });
  }

  const menu: Menu = {
    categories: parsed.data.categories,
    items: parsed.data.items.map((it) => ({
      id: it.id,
      name: it.name,
      description: it.description ?? undefined,
      price: centsToDollars(it.priceCents),
      imageUrl: it.imageUrl ?? undefined,
      category: it.category,
      available: it.available,
      modifierGroups: it.modifierGroups.map((g) => ({
        id: g.id,
        name: g.name,
        minSelections: g.minSelections,
        maxSelections: g.maxSelections,
        modifiers: g.modifiers.map((m) => ({
          id: m.id,
          name: m.name,
          priceDelta: centsToDollars(m.priceDeltaCents),
          group: m.group,
        })),
      })),
    })),
  };
  return NextResponse.json(menu);
}
