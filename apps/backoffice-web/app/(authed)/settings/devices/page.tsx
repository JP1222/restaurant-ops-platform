"use client";

import { AddDeviceDialog } from "@/components/admin/add-device-dialog";
import { DevicesTable } from "@/components/admin/devices-table";
import { SettingsPanel } from "@/components/settings/settings-panel";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAdminDevices } from "@/hooks/use-admin-devices";

export default function DevicesSettingsPage() {
  const query = useAdminDevices();

  return (
    <SettingsPanel
      id="devices"
      action={query.data?.merchantId ? <AddDeviceDialog merchantId={query.data.merchantId} /> : null}
    >
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-medium">Registered devices</CardTitle>
          <CardDescription>
            {query.data?.merchantId ? `Merchant: ${query.data.merchantId}` : "Resolving active merchant..."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {query.isLoading ? (
            <Skeleton className="h-[200px] w-full" />
          ) : query.isError ? (
            <p className="text-sm text-destructive">
              Could not load devices: {query.error instanceof Error ? query.error.message : "unknown"}
            </p>
          ) : query.data ? (
            <DevicesTable devices={query.data.devices} />
          ) : null}
        </CardContent>
      </Card>
    </SettingsPanel>
  );
}
