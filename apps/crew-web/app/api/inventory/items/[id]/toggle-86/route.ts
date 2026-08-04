import { forwardCrewWrite } from "@/lib/server/inventory-api";

export async function POST(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return forwardCrewWrite(`/api/inventory/items/${encodeURIComponent(id)}/toggle-86`, {
    confirm: true
  });
}
