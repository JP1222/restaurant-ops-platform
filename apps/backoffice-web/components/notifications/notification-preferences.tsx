"use client";

import { Info, MoonStar } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { minSeverityMeta } from "@/lib/notifications/meta";
import type { Category, NotificationChannel } from "@/lib/notifications/types";
import { useNotificationStore } from "@/stores/notifications";
import { cn } from "@/lib/utils";
import { NotifIcon } from "./notif-icon";

const CATEGORY_ORDER: Category[] = ["sales", "inv", "dev", "cost", "intg"];

const CHANNELS: { key: NotificationChannel; label: string }[] = [
  { key: "inapp", label: "In-app" },
  { key: "email", label: "Email" },
  { key: "push", label: "Push" },
];

const ROW_GRID = "grid grid-cols-[1fr_130px_56px_56px_56px] items-center";

export function NotificationPreferences() {
  const prefs = useNotificationStore((s) => s.prefs);
  const togglePrefChannel = useNotificationStore((s) => s.togglePrefChannel);
  const cyclePrefSeverity = useNotificationStore((s) => s.cyclePrefSeverity);
  const toggleQuiet = useNotificationStore((s) => s.toggleQuiet);

  return (
    <div className="flex flex-col gap-6">
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div
          className={cn(
            ROW_GRID,
            "border-b border-border bg-secondary px-[18px] py-3 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase",
          )}
        >
          <span>Category</span>
          <span>Min. severity</span>
          <span className="text-center">In-app</span>
          <span className="text-center">Email</span>
          <span className="text-center">Push</span>
        </div>

        {CATEGORY_ORDER.map((key) => {
          const c = prefs.cats[key];
          const sev = minSeverityMeta[c.sev];
          return (
            <div key={key} className={cn(ROW_GRID, "border-b border-border px-[18px] py-3.5 last:border-b-0")}>
              <div className="flex min-w-0 items-center gap-3">
                <span className="inline-flex size-[34px] shrink-0 items-center justify-center rounded-[9px] bg-muted text-foreground">
                  <NotifIcon name={c.icon} className="size-4" />
                </span>
                <span className="text-sm font-medium">{c.label}</span>
              </div>
              <div>
                <button
                  type="button"
                  onClick={() => cyclePrefSeverity(key)}
                  aria-label={`${c.label} minimum severity: ${sev.label}`}
                  className={cn(
                    "inline-flex h-7 items-center gap-1.5 rounded-full border border-border bg-card px-2.5 text-xs font-medium transition-colors hover:bg-muted",
                    sev.text,
                  )}
                >
                  <span className={cn("size-[7px] rounded-full", sev.dot)} />
                  {sev.label}
                </button>
              </div>
              {CHANNELS.map((ch) => (
                <div key={ch.key} className="flex justify-center">
                  <Switch
                    className="data-checked:bg-accent"
                    checked={c[ch.key]}
                    onCheckedChange={() => togglePrefChannel(key, ch.key)}
                    aria-label={`${c.label} — ${ch.label}`}
                  />
                </div>
              ))}
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-3.5 rounded-xl border border-border bg-card px-5 py-[18px]">
        <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-accent-soft text-accent">
          <MoonStar className="size-[19px]" />
        </span>
        <div className="flex-1">
          <div className="font-medium">Quiet hours</div>
          <div className="mt-0.5 text-sm text-muted-foreground">
            Mute non-critical alerts overnight · {prefs.quietFrom} – {prefs.quietTo}
          </div>
        </div>
        <Switch
          className="data-checked:bg-accent"
          checked={prefs.quiet}
          onCheckedChange={() => toggleQuiet()}
          aria-label="Quiet hours"
        />
      </div>

      <p className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
        <Info className="size-3.5" />
        Critical alerts always reach in-app, even during quiet hours.
      </p>
    </div>
  );
}
