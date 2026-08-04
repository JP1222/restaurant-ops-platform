"use client";

import { CloverDashboardCard } from "@/components/admin/clover-dashboard-card";
import { CloverStatusCard } from "@/components/admin/clover-status-card";
import { DeliverectSettingsForm } from "@/components/admin/deliverect-settings-form";
import { SettingsPanel } from "@/components/settings/settings-panel";
import { Skeleton } from "@/components/ui/skeleton";
import { useAdminCloverIntegration } from "@/hooks/use-admin-clover";
import { useAdminDeliverectIntegration } from "@/hooks/use-admin-deliverect-integration";

export default function IntegrationsSettingsPage() {
  const cloverQuery = useAdminCloverIntegration();
  const deliverectQuery = useAdminDeliverectIntegration();

  return (
    <SettingsPanel id="integrations">
      <div className="space-y-6">
        {cloverQuery.isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-[260px] w-full" />
            <Skeleton className="h-[260px] w-full" />
            <Skeleton className="h-[200px] w-full" />
          </div>
        ) : cloverQuery.isError ? (
          <p className="text-sm text-destructive">
            Could not load Clover integration:{" "}
            {cloverQuery.error instanceof Error ? cloverQuery.error.message : "unknown"}
          </p>
        ) : cloverQuery.data ? (
          <>
            <CloverStatusCard data={cloverQuery.data} />
            <CloverDashboardCard dashboard={cloverQuery.data.dashboard} readiness={cloverQuery.data.readiness} />
          </>
        ) : null}

        {deliverectQuery.isLoading ? (
          <Skeleton className="h-[420px] w-full" />
        ) : deliverectQuery.isError ? (
          <p className="text-sm text-destructive">
            Could not load Deliverect integration:{" "}
            {deliverectQuery.error instanceof Error ? deliverectQuery.error.message : "unknown"}
          </p>
        ) : (
          <DeliverectSettingsForm initial={deliverectQuery.data ?? null} />
        )}
      </div>
    </SettingsPanel>
  );
}
