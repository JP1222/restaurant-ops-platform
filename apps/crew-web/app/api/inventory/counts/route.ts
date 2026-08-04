import { forwardCrewWrite } from "@/lib/server/inventory-api";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  return forwardCrewWrite("/api/inventory/counts", { ...body, who: "crew" });
}
