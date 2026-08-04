import { Suspense } from "react";
import { ComparePageClient } from "@/components/compare/compare-page-client";
import { Skeleton } from "@/components/ui/skeleton";

export default function ComparePage() {
  return (
    <Suspense fallback={<ComparePageFallback />}>
      <ComparePageClient />
    </Suspense>
  );
}

function ComparePageFallback() {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-5 w-[34rem] max-w-full" />
      </header>
      <Skeleton className="h-9 w-full max-w-3xl" />
      <Skeleton className="h-9 w-full max-w-4xl" />
      <Skeleton className="h-[420px] w-full" />
    </div>
  );
}
