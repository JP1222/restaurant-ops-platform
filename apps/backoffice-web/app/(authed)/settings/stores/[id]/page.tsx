"use client";

import { use } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { SettingsPanel } from "@/components/settings/settings-panel";
import { useLocations } from "@/hooks/use-locations";
import { StoreDetail } from "@/components/stores/store-detail";

interface StoreDetailPageProps {
  params: Promise<{ id: string }>;
}

export default function StoreDetailPage({ params }: StoreDetailPageProps) {
  const { id } = use(params);
  const { data, isLoading, isError } = useLocations();

  const location = data?.locations.find((l) => l.id === id);

  return (
    <SettingsPanel id="stores">
      {isLoading ? (
        <div className="space-y-3 max-w-[760px]">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-[220px] w-full" />
          <Skeleton className="h-[80px] w-full" />
        </div>
      ) : isError || !location ? (
        <p className="text-sm text-destructive">
          {isError ? "Could not load store." : "Store not found."}
        </p>
      ) : (
        <StoreDetail
          location={location}
          // merchantName, locationLabel, tokenLast4, environment would come from a
          // per-store detail endpoint in Phase 2 — these are stubbed until then.
          merchantName={location.merchantId ? "Example Kitchen LLC" : undefined}
          locationLabel={location.timezone ? `${location.name} · ${location.timezone} · USD` : undefined}
          tokenLast4={location.merchantId ? "4f2a" : undefined}
          environment={location.merchantId?.startsWith("square:") ? "sandbox" : undefined}
        />
      )}
    </SettingsPanel>
  );
}
