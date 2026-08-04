"use client";

import { HoursPanel } from "@/components/settings/panels/hours-panel";
import { SettingsPanel } from "@/components/settings/settings-panel";
import { Skeleton } from "@/components/ui/skeleton";
import { useStoreHours } from "@/hooks/use-store-hours";

export default function StoreHoursSettingsPage() {
  const query = useStoreHours();

  return (
    <SettingsPanel id="hours">
      {query.isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-[360px] w-full" />
          <Skeleton className="h-[96px] w-full" />
        </div>
      ) : query.isError ? (
        <p className="text-sm text-destructive">
          Could not load store hours:{" "}
          {query.error instanceof Error ? query.error.message : "unknown error"}
        </p>
      ) : query.data ? (
        <HoursPanel initial={query.data} />
      ) : null}
    </SettingsPanel>
  );
}
