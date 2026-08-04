import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

interface SettingsCardProps {
  icon: LucideIcon;
  title: string;
  description: string;
  /** Tint for the icon tile — a CSS color, e.g. var(--ws-kds). */
  accent?: string;
  children: ReactNode;
}

// Card with a tinted icon-tile header (CardHead in the design), used by the
// KDS panels (Board Settings, Daily Reset). Rows go in the body.
export function SettingsCard({ icon: Icon, title, description, accent = "var(--accent)", children }: SettingsCardProps) {
  return (
    <div className="rounded-xl border bg-card shadow-sm">
      <div className="flex items-start gap-3 px-5 pt-5 pb-1">
        <div
          className="flex size-9 shrink-0 items-center justify-center rounded-lg"
          style={{ background: `color-mix(in oklch, ${accent} 14%, var(--card))`, color: accent }}
        >
          <Icon className="size-4.5" />
        </div>
        <div>
          <div className="text-sm font-semibold">{title}</div>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="px-5 pb-1">{children}</div>
    </div>
  );
}
