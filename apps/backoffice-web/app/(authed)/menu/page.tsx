import { Suspense } from "react";
import { MenuPageClient } from "@/components/menu/menu-page-client";
import { Skeleton } from "@/components/ui/skeleton";

export default function MenuPage() {
  return (
    <Suspense fallback={<MenuPageFallback />}>
      <MenuPageClient />
    </Suspense>
  );
}

function MenuPageFallback() {
  return (
    <div className="space-y-6 p-6">
      <header>
        <Skeleton className="h-9 w-56" />
        <Skeleton className="mt-2 h-5 w-96 max-w-full" />
      </header>
      <Skeleton className="h-[420px] w-full" />
      <Skeleton className="h-[320px] w-full" />
    </div>
  );
}
