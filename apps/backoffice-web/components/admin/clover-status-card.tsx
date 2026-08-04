"use client";

import Link from "next/link";
import { RotateCcw } from "lucide-react";
import type { CloverIntegrationResponse } from "@rop/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import { RelativeTime } from "@/components/ops/relative-time";

interface CloverStatusCardProps {
  data: CloverIntegrationResponse;
}

export function CloverStatusCard({ data }: CloverStatusCardProps) {
  const { merchant, status } = data;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-medium">Clover connection</CardTitle>
        <CardDescription>
          Active merchant, auth status, and the last time real data flowed through.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {merchant ? (
          <>
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Merchant ID">
                <span className="font-mono">{merchant.id}</span>
              </Field>
              <Field label="Auth status">
                <AuthStatusBadge status={merchant.authStatus} />
              </Field>
              <Field label="Webhook status">
                {merchant.webhookStatus ? (
                  <Badge variant="outline">{merchant.webhookStatus}</Badge>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </Field>
              <Field label="Region">
                <span>{merchant.region ?? "—"}</span>
              </Field>
              <Field label="Connection type">
                <span>
                  {merchant.isOauthConnected
                    ? "OAuth (app installed)"
                    : merchant.isLegacyTokenRecord
                      ? "Legacy token record"
                      : "Static token mode"}
                </span>
              </Field>
              <Field label="Last webhook">
                {merchant.lastWebhookAt ? (
                  <RelativeTime iso={merchant.lastWebhookAt} />
                ) : (
                  <span className="text-muted-foreground">never</span>
                )}
              </Field>
              <Field label="Last sync">
                {merchant.lastSyncAt ? (
                  <RelativeTime iso={merchant.lastSyncAt} />
                ) : (
                  <span className="text-muted-foreground">never</span>
                )}
              </Field>
              <Field label="Last reconciled">
                {merchant.lastReconciledAt ? (
                  <RelativeTime iso={merchant.lastReconciledAt} />
                ) : (
                  <span className="text-muted-foreground">never</span>
                )}
              </Field>
            </dl>
            <p className="text-xs text-muted-foreground">
              Status snapshot at <RelativeTime iso={status.lastWebhookAt ?? merchant.updatedAt} />.
            </p>
            <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/40 p-3">
              <div className="space-y-0.5">
                <p className="text-sm font-medium">Load historical orders</p>
                <p className="text-xs text-muted-foreground">
                  Pull past Clover orders into analytics from the Backfill console.
                </p>
              </div>
              <Button variant="outline" size="sm" asChild>
                <Link href="/ops?tab=backfill">
                  <RotateCcw className="size-4" />
                  Backfill
                </Link>
              </Button>
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            No Clover merchant configured yet. Connect one through the Clover OAuth setup flow to bootstrap the integration.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function AuthStatusBadge({ status }: { status: string }) {
  if (status === "ACTIVE") {
    return <Badge>active</Badge>;
  }
  if (status === "REVOKED") {
    return <Badge variant="destructive">revoked</Badge>;
  }
  return <Badge variant="outline">{status.toLowerCase()}</Badge>;
}
