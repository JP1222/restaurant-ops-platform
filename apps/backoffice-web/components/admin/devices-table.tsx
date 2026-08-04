"use client";

import { useState } from "react";
import type { KdsDevice } from "@rop/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table";
import { useRevokeDevice } from "@/hooks/use-admin-devices";
import { RelativeTime } from "@/components/ops/relative-time";

interface DevicesTableProps {
  devices: KdsDevice[];
}

export function DevicesTable({ devices }: DevicesTableProps) {
  const revoke = useRevokeDevice();
  const [pendingId, setPendingId] = useState<string | null>(null);

  if (devices.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No devices registered yet. Add one to bind a KDS tablet or kitchen screen.
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Label</TableHead>
          <TableHead>Role</TableHead>
          <TableHead>Created</TableHead>
          <TableHead>Last used</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {devices.map((device) => {
          const isRevoked = Boolean(device.revokedAt);
          return (
            <TableRow key={device.id}>
              <TableCell className="font-medium">{device.label}</TableCell>
              <TableCell className="tabular-nums">{device.role}</TableCell>
              <TableCell className="text-muted-foreground">
                <RelativeTime iso={device.createdAt} />
              </TableCell>
              <TableCell className="text-muted-foreground">
                {device.lastUsedAt ? <RelativeTime iso={device.lastUsedAt} /> : "never"}
              </TableCell>
              <TableCell>
                {isRevoked ? (
                  <Badge variant="outline" className="text-muted-foreground">
                    revoked
                  </Badge>
                ) : (
                  <Badge>active</Badge>
                )}
              </TableCell>
              <TableCell className="text-right">
                {isRevoked ? null : (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pendingId === device.id && revoke.isPending}
                    onClick={async () => {
                      const confirmed = window.confirm(
                        `Revoke "${device.label}"? The device will lose access immediately.`
                      );
                      if (!confirmed) return;
                      setPendingId(device.id);
                      try {
                        await revoke.mutateAsync(device.id);
                      } finally {
                        setPendingId(null);
                      }
                    }}
                  >
                    Revoke
                  </Button>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
