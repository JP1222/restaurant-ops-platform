"use client";

import type {
  CloverEnvReadinessItem,
  CloverIntegrationDashboard
} from "@rop/contracts";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";

interface CloverDashboardCardProps {
  dashboard: CloverIntegrationDashboard;
  readiness: { env: CloverEnvReadinessItem[] };
}

export function CloverDashboardCard({ dashboard, readiness }: CloverDashboardCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-medium">Clover dashboard configuration</CardTitle>
        <CardDescription>
          Reference URLs and IDs to paste into Clover&apos;s Merchant Dashboard if you decide to
          switch from static-token mode to OAuth.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Row label="Site URL" value={dashboard.siteUrl} />
          <Row label="Alternate launch path" value={dashboard.alternateLaunchPath} />
          <Row label="OAuth redirect URI" value={dashboard.oauthRedirectUri} />
          <Row label="Webhook URL" value={dashboard.webhookUrl} />
          <Row label="Default OAuth response" value={dashboard.defaultOAuthResponse} />
          <Row
            label="Initial subscriptions"
            value={dashboard.initialSubscriptions.join(", ") || "—"}
          />
          <Row
            label="Initial permissions"
            value={dashboard.initialPermissions.join(", ") || "—"}
          />
        </dl>

        <div className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Environment readiness
          </h3>
          <ReadinessList items={readiness.env} />
        </div>
      </CardContent>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="break-all font-mono text-xs">{value}</dd>
    </div>
  );
}

function ReadinessList({ items }: { items: CloverEnvReadinessItem[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="space-y-1">
      {items.map((item) => (
        <li key={item.name} className="flex items-start gap-2 text-xs">
          <Badge variant={item.ready ? "default" : "outline"} className="shrink-0">
            {item.ready ? "ready" : "blank"}
          </Badge>
          <div className="min-w-0">
            <span className="font-mono">{item.name}</span>
            <span className="text-muted-foreground"> — {item.detail}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}
