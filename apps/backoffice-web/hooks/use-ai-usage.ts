"use client";

import { useQuery } from "@tanstack/react-query";
import type { AiUsagePeriod, AiUsageReport } from "@/lib/ai/usage";

// Reads the AI usage/cost report for a period from the BFF. `import type` keeps the
// server-only usage module (Prisma) out of the client bundle — only the shapes cross.
export function useAiUsage(period: AiUsagePeriod) {
  return useQuery({
    queryKey: ["ai-usage", period],
    queryFn: async (): Promise<AiUsageReport> => {
      const res = await fetch(`/api/ai/usage?period=${period}`, {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`ai_usage_failed_${res.status}`);
      return (await res.json()) as AiUsageReport;
    },
    staleTime: 60_000,
  });
}
