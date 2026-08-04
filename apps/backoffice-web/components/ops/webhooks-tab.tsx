"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useOpsWebhooks } from "@/hooks/use-ops";
import { RelativeTime } from "./relative-time";
import { StatusBadge } from "./status-badge";

export function WebhooksTab() {
  const query = useOpsWebhooks();

  if (query.isLoading) {
    return <Skeleton className="h-[320px] w-full" />;
  }

  if (query.isError || !query.data) {
    return <p className="text-sm text-muted-foreground">Could not load webhooks.</p>;
  }

  const verifications = query.data.verifications;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-medium">Clover Webhook Verifications</CardTitle>
        <CardDescription>Recent verification codes received from Clover.</CardDescription>
      </CardHeader>
      <CardContent className="max-h-[500px] space-y-1 overflow-y-auto pr-1">
        {verifications.length === 0 ? (
          <p className="text-sm text-muted-foreground">No webhook verifications recorded.</p>
        ) : (
          verifications.map((verification) => (
            <div
              key={verification.id}
              className="flex items-center justify-between gap-4 border-b border-card-border pb-2 last:border-0"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm font-medium">{verification.code}</span>
                  <StatusBadge
                    status={verification.used_at ? "healthy" : "pending"}
                    label={verification.used_at ? "used" : "unused"}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Received <RelativeTime iso={verification.received_at} />
                </p>
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">
                Used <RelativeTime iso={verification.used_at} />
              </span>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
