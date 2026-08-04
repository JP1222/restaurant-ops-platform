import { Suspense } from "react";
import { InventoryPageClient } from "@/components/inventory/inventory-page-client";
import { Skeleton } from "@/components/ui/skeleton";

export default function InventoryPage() {
  // InventoryPageClient reads ?tab= via useSearchParams (the cost-coverage deep
  // link), which requires a Suspense boundary so the build doesn't bail the page
  // into a client-side render error at prerender. Same pattern as the /compare page.
  return (
    <Suspense fallback={<InventoryPageFallback />}>
      <InventoryPageClient />
    </Suspense>
  );
}

function InventoryPageFallback() {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Skeleton className="h-9 w-44" />
        <Skeleton className="h-5 w-[30rem] max-w-full" />
      </header>
      <Skeleton className="h-9 w-full max-w-3xl" />
      <Skeleton className="h-[420px] w-full" />
    </div>
  );
}
