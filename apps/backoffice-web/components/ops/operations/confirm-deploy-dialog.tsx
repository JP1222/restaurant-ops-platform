"use client";

import { useState } from "react";
import { Rocket, TriangleAlert } from "lucide-react";
import { opsBuildApps } from "@rop/contracts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import type { DeployOptionsState } from "@/hooks/use-ops-deploy";

const ALL_APPS_COUNT = opsBuildApps.length;

export function ConfirmDeployDialog({
  open,
  onOpenChange,
  options,
  driftApps,
  routeSummary,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  options: DeployOptionsState;
  driftApps: readonly string[];
  routeSummary: string;
  onConfirm: () => void;
}) {
  const force = options.mode === "force_all";
  const [ack, setAck] = useState(false);

  // Clear the force_all acknowledgment on close so the next open starts unticked.
  const handleOpenChange = (next: boolean) => {
    if (!next) setAck(false);
    onOpenChange(next);
  };

  const rows: Array<[string, string]> = [
    [
      "Scope",
      force
        ? `Rebuild all · ${ALL_APPS_COUNT} apps`
        : `Incremental · ${driftApps.length} changed app${driftApps.length === 1 ? "" : "s"}`,
    ],
    ["Apps", force ? "all 8 apps" : driftApps.length ? driftApps.join(", ") : "no changed apps"],
    ["Deploy", options.skipDeploy ? "Skipped — build & push only" : "Host redeploy after push"],
    ["Runner", routeSummary],
  ];

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Rocket className="size-5" />
            Run deploy?
          </AlertDialogTitle>
          <AlertDialogDescription>
            This dispatches <code className="bg-muted rounded px-1 font-mono text-xs">build-images.yml</code>{" "}
            on <code className="bg-muted rounded px-1 font-mono text-xs">main</code>. Review before you
            fire it.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="grid gap-2 text-[0.82rem]">
          {rows.map(([key, value]) => (
            <div key={key} className="flex gap-3">
              <span className="text-muted-foreground w-16 shrink-0">{key}</span>
              <span className="font-medium">{value}</span>
            </div>
          ))}
        </div>

        {force ? (
          <div className="border-[color:var(--chart-4)]/30 bg-[color:var(--chart-4)]/10 grid gap-2.5 rounded-md border p-3">
            <div className="flex items-start gap-2 text-[0.8rem]">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[color:var(--chart-4)]" />
              <span>
                This ignores the path filter and rebuilds <strong>all {ALL_APPS_COUNT} apps</strong> —
                heavier on the runners and slower. Only needed for a clean redeploy or after a
                force-push.
              </span>
            </div>
            <Label className="flex cursor-pointer items-center gap-2.5 text-[0.8rem] font-medium">
              <Checkbox checked={ack} onCheckedChange={(v) => setAck(v === true)} />
              Yes, rebuild all {ALL_APPS_COUNT} apps
            </Label>
          </div>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={force && !ack}
            onClick={onConfirm}
            className="bg-[color:var(--accent)] text-[color:var(--accent-foreground)] hover:bg-[color:var(--accent)]/90"
          >
            <Rocket className="size-4" />
            Deploy now
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
