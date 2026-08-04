"use client";

import { useMemo, useState } from "react";
import { Clock } from "lucide-react";
import { toast } from "sonner";
import { STORE_WEEKDAYS, type StoreHoursResponse, type StoreWeekday } from "@rop/contracts";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useSaveStoreHours } from "@/hooks/use-store-hours";
import { timezoneOptions } from "@/lib/timezones";
import { SettingsCard } from "./settings-card";

const DAY_LABEL: Record<StoreWeekday, string> = {
  sun: "Sunday",
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
};

const FALLBACK_OPEN = { open: "10:00", close: "20:00" } as const;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const SAVE_ERROR_COPY: Record<string, string> = {
  no_store_selected: "Pick a store with the store switcher first, then save.",
  selected_store_not_found: "That store no longer exists — reload and try again.",
};

type Hours = StoreHoursResponse["hours"];

interface HoursPanelProps {
  initial: StoreHoursResponse;
}

export function HoursPanel({ initial }: HoursPanelProps) {
  const save = useSaveStoreHours();
  const [hours, setHours] = useState<Hours>(initial.hours);
  const [timezone, setTimezone] = useState<string>(initial.timezone);

  const dirty = useMemo(
    () =>
      timezone !== initial.timezone || JSON.stringify(hours) !== JSON.stringify(initial.hours),
    [hours, timezone, initial],
  );

  const hasInvalidDay = STORE_WEEKDAYS.some((key) => {
    const day = hours[key];
    return day !== null && (!TIME_RE.test(day.open) || !TIME_RE.test(day.close) || day.open >= day.close);
  });

  const setDay = (key: StoreWeekday, value: Hours[StoreWeekday]) =>
    setHours((prev) => ({ ...prev, [key]: value }));

  const tzOptions = timezoneOptions(timezone);

  const onSave = () => {
    save.mutate(
      { timezone, hours },
      {
        onSuccess: () => toast.success("Store hours saved"),
        onError: (error) => {
          const key = error instanceof Error ? error.message : "";
          toast.error(SAVE_ERROR_COPY[key] ?? "Could not save store hours");
        },
      },
    );
  };

  return (
    <div className="space-y-4">
      <SettingsCard
        icon={Clock}
        title="Opening hours"
        description="Per weekday, in the store's local time. Drives how the dashboard frames the day (pre-open vs. open) and which day it labels as today."
      >
        {initial.source === "default" ? (
          <p className="mb-3 text-xs text-muted-foreground">
            Showing default hours — save to set this store&apos;s own.
          </p>
        ) : null}

        <div className="divide-y divide-border">
          {STORE_WEEKDAYS.map((key) => {
            const day = hours[key];
            return (
              <div key={key} className="flex items-center gap-3 py-2.5">
                <Label className="w-24 shrink-0 text-sm font-normal">{DAY_LABEL[key]}</Label>
                <Switch
                  className="data-checked:bg-accent"
                  checked={day !== null}
                  onCheckedChange={(open) => setDay(key, open ? (day ?? { ...FALLBACK_OPEN }) : null)}
                  aria-label={`${DAY_LABEL[key]} open`}
                />
                {day !== null ? (
                  <div className="flex items-center gap-2">
                    <Input
                      type="time"
                      className="w-32 tabular-nums"
                      value={day.open}
                      aria-label={`${DAY_LABEL[key]} open time`}
                      onChange={(e) => setDay(key, { open: e.target.value, close: day.close })}
                    />
                    <span className="text-sm text-muted-foreground">to</span>
                    <Input
                      type="time"
                      className="w-32 tabular-nums"
                      value={day.close}
                      aria-label={`${DAY_LABEL[key]} close time`}
                      onChange={(e) => setDay(key, { open: day.open, close: e.target.value })}
                    />
                  </div>
                ) : (
                  <span className="text-sm text-muted-foreground">Closed</span>
                )}
              </div>
            );
          })}
        </div>

        {hasInvalidDay ? (
          <p className="mt-2 text-xs text-[color:var(--trend-down)]">
            Each open time must be a valid time before its close time.
          </p>
        ) : null}
      </SettingsCard>

      <SettingsCard
        icon={Clock}
        title="Timezone"
        description="The store's local timezone — anchors business-day boundaries and the hours above. Per store, so a second location can sit in another zone."
      >
        <div className="flex items-center justify-between gap-3 py-1.5">
          <Label className="text-sm font-normal">Store timezone</Label>
          <Select value={timezone} onValueChange={setTimezone}>
            <SelectTrigger className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {tzOptions.map((tz) => (
                <SelectItem key={tz} value={tz}>
                  {tz}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </SettingsCard>

      <div className="flex items-center justify-end gap-3">
        {dirty ? <span className="text-xs text-muted-foreground">Unsaved changes</span> : null}
        <Button onClick={onSave} disabled={!dirty || hasInvalidDay || save.isPending}>
          {save.isPending ? "Saving…" : "Save hours"}
        </Button>
      </div>
    </div>
  );
}
