"use client";

import { BoardPanel } from "@/components/settings/panels/board-panel";
import { SettingsPanel } from "@/components/settings/settings-panel";
import { Skeleton } from "@/components/ui/skeleton";
import { useAdminBoardSettings } from "@/hooks/use-admin-board-settings";

export default function BoardSettingsPage() {
  const query = useAdminBoardSettings();

  return (
    <SettingsPanel id="board">
      {query.isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-[200px] w-full" />
          <Skeleton className="h-[240px] w-full" />
          <Skeleton className="h-[140px] w-full" />
        </div>
      ) : query.isError ? (
        <p className="text-sm text-destructive">
          Could not load board settings: {query.error instanceof Error ? query.error.message : "unknown"}
        </p>
      ) : query.data ? (
        <BoardPanel settings={query.data.settings} merchantId={query.data.merchantId} />
      ) : null}
    </SettingsPanel>
  );
}
