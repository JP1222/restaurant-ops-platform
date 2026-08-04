import { forwardCrewWrite } from "@/lib/server/inventory-api";

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  return forwardCrewWrite(`/api/inventory/pos/${encodeURIComponent(id)}/receive`, {
    ...body,
    who: "crew"
  });
}
