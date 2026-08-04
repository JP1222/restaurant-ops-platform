import { Suspense } from "react";
import { TrendsPageClient } from "@/components/trends/trends-page-client";
import { Skeleton } from "@/components/ui/skeleton";

export default function TrendsPage() {
  return (
    <Suspense fallback={<TrendsPageFallback />}>
      <TrendsPageClient />
    </Suspense>
  );
}

function TrendsPageFallback() {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Skeleton className="h-9 w-36" />
        <Skeleton className="h-5 w-96 max-w-full" />
      </header>
      <Skeleton className="h-9 w-full max-w-3xl" />
      <Skeleton className="h-[420px] w-full" />
    </div>
  );
}
