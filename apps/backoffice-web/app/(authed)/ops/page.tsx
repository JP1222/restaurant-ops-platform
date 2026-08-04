import { Suspense } from "react";
import { OpsPageClient } from "@/components/ops/ops-page-client";
import { Skeleton } from "@/components/ui/skeleton";

export default function OpsPage() {
  return (
    <Suspense fallback={<OpsPageFallback />}>
      <OpsPageClient />
    </Suspense>
  );
}

function OpsPageFallback() {
  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-5 w-full max-w-2xl" />
      </header>
      <Skeleton className="h-9 w-full max-w-3xl" />
      <Skeleton className="h-[400px] w-full" />
    </div>
  );
}
