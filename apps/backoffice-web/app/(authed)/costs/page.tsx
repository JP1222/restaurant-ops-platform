import { Suspense } from "react";
import { CostsPageClient } from "@/components/costs/costs-page-client";
import { Skeleton } from "@/components/ui/skeleton";

export default function CostsPage() {
  return (
    <Suspense fallback={<CostsPageFallback />}>
      <CostsPageClient />
    </Suspense>
  );
}

function CostsPageFallback() {
  return (
    <div className="space-y-6 p-6">
      <header>
        <Skeleton className="h-9 w-56" />
        <Skeleton className="mt-2 h-5 w-96 max-w-full" />
      </header>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-[208px] w-full" />
        ))}
      </div>
      <Skeleton className="h-[360px] w-full" />
    </div>
  );
}
