"use client";

import { Activity, RefreshCw, Settings as SettingsIcon, Sun } from "lucide-react";
import type { KitchenBoardSettings } from "@rop/contracts";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { CommitField } from "../commit-field";
import { NumberField } from "../number-field";
import { Segmented } from "../segmented";
import { SettingRow } from "../setting-row";
import { SettingsCard } from "./settings-card";
import { useBoardSettingsSave } from "./use-board-settings-save";

const COUNTRIES = ["US", "CA", "MX", "GB"];

interface BoardPanelProps {
  settings: KitchenBoardSettings;
  merchantId: string;
}

export function BoardPanel({ settings, merchantId }: BoardPanelProps) {
  const { save, status } = useBoardSettingsSave(merchantId);
  const weather = settings.display.weather;
  const weatherOn = weather.enabled;
  const crossed = settings.urgencyWarningMinutes >= settings.urgencyCriticalMinutes;

  const patchWeather = (next: Partial<typeof weather>) => ({
    ...settings,
    display: { ...settings.display, weather: { ...weather, ...next } },
  });

  return (
    <div className="space-y-4">
      <SettingsCard
        icon={Activity}
        title="Urgency thresholds"
        accent="var(--ws-kds)"
        description="Minutes-since-fire after which a ticket turns warning, then critical, on the board."
      >
        <SettingRow
          label="Warning at"
          description="Ticket turns amber once it's been on the line this long."
          status={status("urgencyWarningMinutes")}
        >
          <NumberField
            value={settings.urgencyWarningMinutes}
            min={1}
            max={240}
            unit="min"
            onCommit={(n) => save("urgencyWarningMinutes", { ...settings, urgencyWarningMinutes: n })}
          />
        </SettingRow>

        <SettingRow
          label="Critical at"
          description="Ticket turns red — should be ahead of your service promise."
          status={status("urgencyCriticalMinutes")}
          note={
            crossed ? (
              <span className="block text-ws-marketing">
                Critical should be greater than the warning threshold.
              </span>
            ) : null
          }
        >
          <NumberField
            value={settings.urgencyCriticalMinutes}
            min={1}
            max={240}
            unit="min"
            onCommit={(n) => save("urgencyCriticalMinutes", { ...settings, urgencyCriticalMinutes: n })}
          />
        </SettingRow>

        <SettingRow
          label="Blink critical tickets"
          description="Pulse red tickets so the line can't miss them."
          status={status("urgencyBlinkCritical")}
        >
          <Switch
            className="data-checked:bg-accent"
            checked={settings.urgencyBlinkCritical}
            onCheckedChange={(v) => save("urgencyBlinkCritical", { ...settings, urgencyBlinkCritical: v })}
          />
        </SettingRow>
      </SettingsCard>

      <SettingsCard
        icon={RefreshCw}
        title="Order sync"
        accent="var(--ws-kds)"
        description="How often the backend polls Clover for new and changed orders. Lower is closer to real-time; around 3 seconds is near-instant. Going below ~2 seconds needs webhooks."
      >
        <SettingRow
          label="Poll interval"
          description="Seconds between Clover order syncs. Takes effect within a few seconds — no restart."
          status={status("reconcileIntervalSeconds")}
        >
          <NumberField
            value={settings.reconcileIntervalSeconds}
            min={3}
            max={300}
            unit="sec"
            onCommit={(n) => save("reconcileIntervalSeconds", { ...settings, reconcileIntervalSeconds: n })}
          />
        </SettingRow>
      </SettingsCard>

      <SettingsCard
        icon={Sun}
        title="Weather widget"
        accent="var(--ws-display)"
        description="Powers the weather pill on the guest pickup display. Configure here — Floor surfaces are read-only."
      >
        <SettingRow
          label="Show weather pill"
          description="Display local conditions on the pickup screen."
          status={status("weather.enabled")}
        >
          <Switch
            className="data-checked:bg-accent"
            checked={weatherOn}
            onCheckedChange={(v) => save("weather.enabled", patchWeather({ enabled: v }))}
          />
        </SettingRow>

        <SettingRow label="ZIP code" description="Location used to fetch conditions." status={status("weather.zipCode")}>
          <CommitField
            value={weather.zipCode}
            placeholder="00000"
            disabled={!weatherOn}
            className="font-mono"
            onCommit={(v) => save("weather.zipCode", patchWeather({ zipCode: v }))}
          />
        </SettingRow>

        <SettingRow label="Country" description="Region for the ZIP lookup." status={status("weather.countryCode")}>
          <Select
            value={weather.countryCode}
            disabled={!weatherOn}
            onValueChange={(v) => save("weather.countryCode", patchWeather({ countryCode: v }))}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {COUNTRIES.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>

        <SettingRow
          label="Temperature unit"
          description="How temperature reads on the pill."
          status={status("weather.unit")}
        >
          <Segmented
            aria-label="Temperature unit"
            value={weather.unit}
            onValueChange={(v) => save("weather.unit", patchWeather({ unit: v === "celsius" ? "celsius" : "fahrenheit" }))}
            options={[
              { value: "fahrenheit", label: "°F" },
              { value: "celsius", label: "°C" },
            ]}
          />
        </SettingRow>
      </SettingsCard>

      <SettingsCard
        icon={SettingsIcon}
        title="Board behavior"
        description="Toggles the kitchen staff feels on every screen."
      >
        <SettingRow
          label="New-ticket chime"
          description="Play a sound when a fresh ticket lands on the board."
          status={status("filter.soundEnabled")}
        >
          <Switch
            className="data-checked:bg-accent"
            checked={settings.filter.soundEnabled}
            onCheckedChange={(v) =>
              save("filter.soundEnabled", { ...settings, filter: { ...settings.filter, soundEnabled: v } })
            }
          />
        </SettingRow>

        <SettingRow
          label="Screen unlock pin"
          description="Require a pin to leave the board or change screens."
          status={status("filter.screenPinEnabled")}
        >
          <Switch
            className="data-checked:bg-accent"
            checked={settings.filter.screenPinEnabled}
            onCheckedChange={(v) =>
              save("filter.screenPinEnabled", { ...settings, filter: { ...settings.filter, screenPinEnabled: v } })
            }
          />
        </SettingRow>
      </SettingsCard>
    </div>
  );
}
