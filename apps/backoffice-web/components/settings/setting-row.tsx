"use client";

import { Clock, Info } from "lucide-react";
import type { ReactNode } from "react";
import type { SettingSource } from "@rop/contracts";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { StatusPill, type SaveStatus } from "./status-pill";

// `db`: operator set this via the UI; `env`: pinned at deploy time via env var
// — UI can edit but a process restart re-applies env unless a DB row exists;
// `default`: hardcoded fallback from settingsRegistry.
const SOURCE_LABEL: Record<SettingSource, string> = {
  db: "Saved",
  env: "Deploy default",
  default: "Built-in default",
};

const SOURCE_VARIANT: Record<SettingSource, "default" | "secondary" | "outline"> = {
  db: "default",
  env: "secondary",
  default: "outline",
};

export type SettingRowAudit = { when: ReactNode; by: string };

interface SettingRowProps {
  label: string;
  description?: string;
  /** Render the description as a hover ⓘ tooltip instead of an always-on paragraph. */
  descriptionTooltip?: boolean;
  source?: SettingSource;
  htmlFor?: string;
  tone?: "danger";
  /** Wider control column for full-width controls (e.g. textarea). */
  full?: boolean;
  /** Per-field save lifecycle. */
  status?: SaveStatus | null;
  /** Inline caution / validation note rendered under the control. */
  note?: ReactNode;
  /** Audit line ("Updated {when} · {by}") shown under db-sourced rows. */
  meta?: SettingRowAudit | null;
  children: ReactNode;
}

export function SettingRow({
  label,
  description,
  descriptionTooltip,
  source,
  htmlFor,
  tone,
  full,
  status,
  note,
  meta,
  children,
}: SettingRowProps) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-6 border-b py-[var(--settings-row-y,1.125rem)] last:border-b-0">
      <div className="min-w-0 space-y-1" style={{ flex: "1 1 240px" }}>
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor={htmlFor} className={cn("text-sm font-medium", tone === "danger" && "text-destructive")}>
            {label}
          </Label>
          {description && descriptionTooltip ? (
            <Tooltip>
              <TooltipTrigger
                type="button"
                aria-label="More info"
                className="text-muted-foreground/55 transition-colors hover:text-foreground focus-visible:text-foreground"
              >
                <Info className="size-3.5" />
              </TooltipTrigger>
              <TooltipContent className="max-w-xs text-left leading-relaxed">{description}</TooltipContent>
            </Tooltip>
          ) : null}
          {source ? (
            <Badge variant={SOURCE_VARIANT[source]} className="text-xs font-normal">
              {SOURCE_LABEL[source]}
            </Badge>
          ) : null}
        </div>
        {description && !descriptionTooltip ? (
          <p className="max-w-[52ch] text-xs text-muted-foreground">{description}</p>
        ) : null}
        {meta ? (
          <p className="flex items-center gap-1.5 pt-1 text-xs text-muted-foreground/85">
            <Clock className="size-3" />
            <span>
              Updated {meta.when} · {meta.by}
            </span>
          </p>
        ) : null}
      </div>
      <div className={cn("flex shrink-0 flex-col items-end gap-1.5", full ? "w-90" : "w-72")}>
        {children}
        {note ? <div className="text-right text-xs leading-snug">{note}</div> : null}
        <StatusPill status={status} />
      </div>
    </div>
  );
}
