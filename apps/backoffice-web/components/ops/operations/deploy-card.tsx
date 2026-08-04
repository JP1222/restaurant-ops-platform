"use client";

import { useState } from "react";
import { Clock, Loader2, Rocket, TriangleAlert } from "lucide-react";
import type { DeployMode, OpsFreshnessResponse } from "@rop/contracts";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import type { DeployController, DeployOptionsState } from "@/hooks/use-ops-deploy";
import { ConfirmDeployDialog } from "./confirm-deploy-dialog";
import { DeployStatus } from "./deploy-status";
import { toneClass } from "./tokens";

const ACCENT_BUTTON =
  "bg-[color:var(--accent)] text-[color:var(--accent-foreground)] hover:bg-[color:var(--accent)]/90";

function DeployOptions({
  options,
  setOptions,
  disabled,
}: {
  options: DeployOptionsState;
  setOptions: DeployController["setOptions"];
  disabled: boolean;
}) {
  return (
    <div className={cn("grid gap-4", disabled && "pointer-events-none opacity-55")}>
      <div className="grid gap-1.5">
        <span className="text-[0.8rem] font-medium">Build scope</span>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={options.mode}
          onValueChange={(value) =>
            value && setOptions((o) => ({ ...o, mode: value as DeployMode }))
          }
          className="w-fit"
        >
          <ToggleGroupItem value="incremental">Incremental</ToggleGroupItem>
          <ToggleGroupItem value="force_all">Rebuild all</ToggleGroupItem>
        </ToggleGroup>
        <span className="text-muted-foreground text-xs">
          {options.mode === "incremental"
            ? "Only apps changed since the last-built marker (default). Unchanged apps never claim a runner."
            : "force_all · ignores the path filter and rebuilds all 8 apps."}
        </span>
      </div>
      <Label className="flex cursor-pointer items-start gap-2.5">
        <Checkbox
          checked={options.skipDeploy}
          onCheckedChange={(value) => setOptions((o) => ({ ...o, skipDeploy: value === true }))}
          className="mt-0.5"
        />
        <span className="grid gap-0.5">
          <span className="text-[0.8rem] font-medium">Build only · skip deploy</span>
          <span className="text-muted-foreground text-xs">
            skip_deploy · build &amp; push to GHCR, don&apos;t roll out to the host (smoke test).
          </span>
        </span>
      </Label>
    </div>
  );
}

export function DeployCard({
  controller,
  fresh,
  locked,
  lockRunNumber,
  routeSummary,
}: {
  controller: DeployController;
  fresh: OpsFreshnessResponse | undefined;
  locked: boolean;
  lockRunNumber: number | undefined;
  routeSummary: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const { options, setOptions, live, progress, activeRun } = controller;

  const driftApps = fresh?.drift ?? [];
  const driftKnown = fresh?.comparedAgainst === "last-built";
  const nothingToBuild = options.mode === "incremental" && driftKnown && driftApps.length === 0;
  const blocked = locked || nothingToBuild;

  const hint = nothingToBuild
    ? "All apps up to date — switch to Rebuild all to force a build"
    : `${
        options.mode === "force_all"
          ? "Rebuilds all apps"
          : driftKnown
            ? `Builds ${driftApps.length} changed app${driftApps.length === 1 ? "" : "s"}`
            : "Builds changed apps"
      }${options.skipDeploy ? " · no redeploy" : ""}`;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base font-medium">
          <Rocket className="text-muted-foreground size-4" />
          Deploy
        </CardTitle>
        <CardDescription>
          Dispatch build-images.yml → build arm64 images → push to GHCR → roll out to host via SSH.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {locked && !live ? (
          <div className={cn("flex items-center gap-2 rounded-md border p-2.5", toneClass.blue)}>
            <Loader2 className="size-3.5 shrink-0 animate-spin" />
            <span className="text-xs">
              Build #{lockRunNumber} is running. Only one deploy runs at a time — wait for it to
              finish.
            </span>
          </div>
        ) : null}

        {live && progress ? (
          <DeployStatus
            progress={progress}
            activeRun={activeRun}
            skipDeploy={options.skipDeploy}
            onReset={controller.reset}
            onRetry={controller.retry}
          />
        ) : (
          <>
            <DeployOptions options={options} setOptions={setOptions} disabled={blocked} />
            {controller.dispatchError ? (
              <div
                className={cn("flex items-start gap-2 rounded-md border p-2.5 text-xs", toneClass.danger)}
              >
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                <span>Dispatch failed: {controller.dispatchError.message}</span>
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-3">
              <Button
                size="lg"
                disabled={blocked}
                onClick={() => setConfirming(true)}
                className={ACCENT_BUTTON}
              >
                {locked ? <Clock className="size-4" /> : <Rocket className="size-4" />}
                {locked ? `Waiting for #${lockRunNumber}…` : "Deploy"}
              </Button>
              <span className="text-muted-foreground text-xs">{hint}</span>
            </div>
          </>
        )}
      </CardContent>

      <ConfirmDeployDialog
        open={confirming}
        onOpenChange={setConfirming}
        options={options}
        driftApps={driftApps}
        routeSummary={routeSummary}
        onConfirm={() => {
          setConfirming(false);
          controller.fire();
        }}
      />
    </Card>
  );
}
