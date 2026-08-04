"use client";

import { ResetPanel } from "@/components/settings/panels/reset-panel";
import { SettingsPanel } from "@/components/settings/settings-panel";
import { Skeleton } from "@/components/ui/skeleton";
import { useAdminBoardSettings } from "@/hooks/use-admin-board-settings";

export default function DailyResetSettingsPage() {
  // The reset schedule lives in board settings (dailyReset* fields); the manual
  // run + last-reset status come from useAdminDailyReset inside ResetPanel.
  const query = useAdminBoardSettings();

  return (
    <SettingsPanel id="reset">
      {query.isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-[220px] w-full" />
          <Skeleton className="h-[88px] w-full" />
        </div>
      ) : query.isError ? (
        <p className="text-sm text-destructive">
          Could not load reset settings: {query.error instanceof Error ? query.error.message : "unknown"}
        </p>
      ) : query.data ? (
        <ResetPanel settings={query.data.settings} merchantId={query.data.merchantId} />
      ) : null}
    </SettingsPanel>
  );
}
