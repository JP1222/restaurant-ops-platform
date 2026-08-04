"use client";

import { Check, Moon, Sun } from "lucide-react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useAppearance } from "@/hooks/use-appearance";
import { Segmented } from "../segmented";
import { SettingRow } from "../setting-row";

export function AppearancePanel() {
  const { theme, setTheme, accent, setAccent, density, setDensity, tabular, setTabular, accentPresets } =
    useAppearance();

  return (
    <div className="rounded-xl border bg-card px-6 shadow-sm">
      <SettingRow label="Theme" description="Light is recommended for bright kitchen environments." source="db">
        <Segmented
          aria-label="Theme"
          value={theme}
          onValueChange={(v) => {
            setTheme(v);
            toast.success(`Theme set to ${v}`);
          }}
          options={[
            { value: "light", label: "Light", icon: Sun },
            { value: "dark", label: "Dark", icon: Moon },
            { value: "system", label: "Auto" },
          ]}
        />
      </SettingRow>

      <SettingRow
        label="Accent color"
        description="Highlights active items, switches, and primary actions."
        source="db"
      >
        <div className="flex gap-2">
          {accentPresets.map((preset) => {
            const selected = accent === preset.value;
            return (
              <button
                key={preset.id}
                type="button"
                title={preset.label}
                aria-label={preset.label}
                aria-pressed={selected}
                onClick={() => {
                  setAccent(preset.value);
                  toast.success(`Accent set to ${preset.label}`);
                }}
                style={{ background: preset.value }}
                className={cn(
                  "grid size-7 place-items-center rounded-md outline outline-border transition-transform",
                  selected ? "ring-2 ring-foreground ring-offset-1 ring-offset-background" : "hover:scale-105"
                )}
              >
                {selected ? <Check className="size-4 text-white" /> : null}
              </button>
            );
          })}
        </div>
      </SettingRow>

      <SettingRow
        label="Density"
        description="Compact fits more rows on smaller KDS-adjacent screens."
        source="default"
      >
        <Segmented
          aria-label="Density"
          value={density}
          onValueChange={(v) => {
            setDensity(v as typeof density);
            toast.success(`Density: ${v}`);
          }}
          options={[
            { value: "compact", label: "Compact" },
            { value: "regular", label: "Regular" },
            { value: "comfy", label: "Comfy" },
          ]}
        />
      </SettingRow>

      <SettingRow
        label="Tabular numerals"
        description="Align digits in tables and analytics for easier scanning."
        source="default"
      >
        <Switch
          className="data-checked:bg-accent"
          checked={tabular}
          onCheckedChange={(v) => {
            setTabular(v);
            toast.success("Updated");
          }}
          aria-label="Tabular numerals"
        />
      </SettingRow>
    </div>
  );
}
