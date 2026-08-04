"use client";

import { useState } from "react";
import { isValidIpAllowlist, parseIpAllowlist } from "@rop/contracts";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useCrewSecurity, useSaveCrewSecurity } from "@/hooks/use-crew";

export function CrewSecurityCard() {
  const query = useCrewSecurity();
  const save = useSaveCrewSecurity();
  const [value, setValue] = useState<string | null>(null);

  // Seed the editable copy from the first successful load (render-time init, not an
  // effect). Once seeded, the user's edits own the field — a background refetch
  // won't clobber an in-progress change.
  if (value === null && query.data) {
    setValue(query.data.crew_ip_allowlist);
  }

  const current = value ?? "";
  const valid = isValidIpAllowlist(current);
  const count = parseIpAllowlist(current).length;
  const dirty = query.data ? current !== query.data.crew_ip_allowlist : false;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-medium">Floor login IP allowlist</CardTitle>
        <CardDescription>
          Restrict which networks can reach the crew PIN login. One IP or IPv4 CIDR per line (for
          example <span className="font-mono">203.0.113.7</span> or{" "}
          <span className="font-mono">203.0.113.0/24</span>). Leave empty to allow any network.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {query.isLoading ? (
          <Skeleton className="h-[140px] w-full" />
        ) : query.isError ? (
          <p className="text-sm text-destructive">
            Could not load settings:{" "}
            {query.error instanceof Error ? query.error.message : "unknown"}
          </p>
        ) : (
          <>
            <div className="space-y-1">
              <Label htmlFor="crew-ip-allowlist">Allowed IPs / CIDRs</Label>
              <Textarea
                id="crew-ip-allowlist"
                value={current}
                onChange={(event) => setValue(event.target.value)}
                placeholder={"203.0.113.7\n198.51.100.0/24"}
                className="min-h-[120px] font-mono text-sm"
                spellCheck={false}
              />
              <p className="text-xs text-muted-foreground">
                {current.trim() === ""
                  ? "Empty - any network can sign in."
                  : `${count} entr${count === 1 ? "y" : "ies"}.`}
              </p>
            </div>

            {!valid ? (
              <Alert variant="destructive">
                <AlertTitle>Invalid entry</AlertTitle>
                <AlertDescription>
                  Each line must be an IP address or IPv4 CIDR.
                </AlertDescription>
              </Alert>
            ) : null}

            <Alert>
              <AlertTitle>Heads up</AlertTitle>
              <AlertDescription>
                Setting the wrong network here locks the floor out of the login. Use the store&apos;s
                public IP. It can take up to 30 seconds to take effect.
              </AlertDescription>
            </Alert>

            {save.isError ? (
              <Alert variant="destructive">
                <AlertTitle>Could not save</AlertTitle>
                <AlertDescription>
                  {save.error instanceof Error ? save.error.message : "unknown"}
                </AlertDescription>
              </Alert>
            ) : null}

            <div className="flex justify-end">
              <Button
                type="button"
                disabled={!valid || !dirty || save.isPending}
                onClick={() => save.mutate({ crew_ip_allowlist: current })}
              >
                {save.isPending ? "Saving..." : "Save allowlist"}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
