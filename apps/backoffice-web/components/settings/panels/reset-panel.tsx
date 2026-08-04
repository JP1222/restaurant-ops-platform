"use client";

import { Clock, RotateCcw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { KitchenBoardSettings } from "@rop/contracts";
import { RelativeTime } from "@/components/ops/relative-time";
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
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useAdminDailyReset, useTriggerDailyReset } from "@/hooks/use-admin-daily-reset";
import { CommitField } from "../commit-field";
import { SettingRow } from "../setting-row";
import { SettingsCard } from "./settings-card";
import { useBoardSettingsSave } from "./use-board-settings-save";

const TIMEZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles"];

interface ResetPanelProps {
  settings: KitchenBoardSettings;
  merchantId: string;
}

export function ResetPanel({ settings, merchantId }: ResetPanelProps) {
  const { save, status } = useBoardSettingsSave(merchantId);
  const dailyReset = useAdminDailyReset();
  const trigger = useTriggerDailyReset();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const enabled = settings.dailyResetEnabled;
  // The schedule lives in board settings; keep the current zone selectable even
  // if it isn't one of the common presets.
  const zones = TIMEZONES.includes(settings.boardTimeZone)
    ? TIMEZONES
    : [settings.boardTimeZone, ...TIMEZONES];

  return (
    <div className="space-y-4">
      <SettingsCard
        icon={Clock}
        title="Automatic reset"
        accent="var(--ws-kds)"
        description="When enabled, the board purges open tickets and rolls reporting to a new business day at this time."
      >
        <SettingRow
          label="Enable daily reset"
          description="Runs unattended at the scheduled time, every day."
          status={status("dailyResetEnabled")}
        >
          <Switch
            className="data-checked:bg-accent"
            checked={enabled}
            onCheckedChange={(v) => save("dailyResetEnabled", { ...settings, dailyResetEnabled: v })}
          />
        </SettingRow>

        <SettingRow
          label="Reset time"
          description="24-hour clock, local to the board timezone."
          status={status("dailyResetTime")}
        >
          <CommitField
            value={settings.dailyResetTime}
            placeholder="21:00"
            className="font-mono"
            disabled={!enabled}
            onCommit={(v) => save("dailyResetTime", { ...settings, dailyResetTime: v })}
          />
        </SettingRow>

        <SettingRow
          label="Board timezone"
          description="IANA zone the reset time is measured in."
          status={status("boardTimeZone")}
        >
          <Select
            value={settings.boardTimeZone}
            disabled={!enabled}
            onValueChange={(v) => save("boardTimeZone", { ...settings, boardTimeZone: v })}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {zones.map((tz) => (
                <SelectItem key={tz} value={tz}>
                  {tz}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
      </SettingsCard>

      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border bg-card px-5 py-4 shadow-sm">
        <div className="min-w-0">
          <div className="text-sm font-medium">Run reset now</div>
          <p className="mt-1 max-w-[62ch] text-xs text-muted-foreground">
            Clears today&apos;s KDS tickets and starts a new business day across every device immediately. Cannot be
            undone.
            {dailyReset.data?.lastResetAt ? (
              <>
                {" "}
                Last reset <RelativeTime iso={dailyReset.data.lastResetAt} />.
              </>
            ) : null}
          </p>
        </div>
        <Button variant="destructive" size="sm" onClick={() => setConfirmOpen(true)} disabled={trigger.isPending}>
          <RotateCcw />
          {trigger.isPending ? "Resetting…" : "Run reset"}
        </Button>
      </div>

      <AlertDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!trigger.isPending) setConfirmOpen(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Run daily reset now?</AlertDialogTitle>
            <AlertDialogDescription>
              This clears all open KDS tickets and starts a new business day across every device. It normally runs
              automatically at the scheduled time — only run it manually if you&apos;re certain.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() =>
                trigger.mutate(undefined, {
                  onSuccess: () => toast.success("Daily reset complete"),
                  onError: (error) =>
                    toast.error(error instanceof Error ? error.message : "Reset failed — try again"),
                })
              }
            >
              Run reset
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
