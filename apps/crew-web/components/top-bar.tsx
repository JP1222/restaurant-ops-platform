"use client";

import { cn } from "@/lib/cn";
import { STRINGS } from "@/lib/strings";
import type { Employee, Lang } from "@/lib/types";
import { useCrewSize } from "@/lib/use-crew-size";

export function CrewTopBar({
  employee,
  lang,
  setLang,
  onLogout,
  onBack,
  title,
  idleSec,
  online = true,
}: {
  employee: Employee;
  lang: Lang;
  setLang: (l: Lang) => void;
  onLogout: () => void;
  onBack?: (() => void) | null;
  title?: string | null;
  idleSec?: number | null;
  // Real connectivity (design handoff §7). Reflected, not interactive: the chip
  // turns amber when the device drops offline; the matching banner lives in the
  // shell (crew-app) just under this bar.
  online?: boolean;
}) {
  const size = useCrewSize();
  const phone = size.kind === "phone";

  return (
    <div
      className={cn(
        "shrink-0 flex items-center gap-3 border-b border-black/5 bg-white/70 backdrop-blur",
        // min-h (not fixed h) + a top inset so the white bar extends under the
        // notch / Dynamic Island and its content sits clear of it. With
        // viewport-fit=cover the bar would otherwise render beneath the status
        // bar. On devices with no inset this collapses to the original height.
        phone ? "min-h-14 px-3" : "min-h-16 px-6 gap-4",
      )}
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      {onBack ? (
        <button
          onClick={onBack}
          aria-label={STRINGS[lang].back}
          className={cn(
            "rounded-xl bg-zinc-100 active:bg-zinc-200 flex items-center justify-center",
            phone ? "size-10" : "size-12",
          )}
        >
          <svg
            viewBox="0 0 24 24"
            width="22"
            height="22"
            fill="none"
            stroke="#27272a"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
      ) : (
        <div className="flex items-center gap-2">
          <span style={{ fontSize: phone ? 22 : 28 }}>🍙</span>
          {!phone && (
            <span className="font-semibold tracking-tight text-zinc-900">
              Crew
            </span>
          )}
        </div>
      )}
      {title && (
        <div
          className={cn(
            "font-semibold tracking-tight text-zinc-900",
            phone ? "text-base ml-0.5 truncate" : "text-lg ml-1",
          )}
        >
          {title}
        </div>
      )}
      <div className="flex-1" />

      {/* Connectivity chip — green "Online" / amber "Offline" (design handoff §7).
          Phone keeps just the dot to spare the crowded bar; the offline banner
          carries the words there. Not a button: it mirrors state, never toggles. */}
      <span
        aria-label={online ? STRINGS[lang].net_online : STRINGS[lang].net_offline}
        className={cn(
          "inline-flex items-center rounded-full font-semibold",
          phone ? "size-9 justify-center" : "h-9 gap-2 px-3.5 text-[13px]",
        )}
        style={
          online
            ? { background: "#ecfdf5", color: "#047857" }
            : { background: "#fef3c7", color: "#b45309" }
        }
      >
        <span
          className="size-2 rounded-full flex-none"
          style={{ background: online ? "#10b981" : "#f59e0b" }}
        />
        {!phone && (online ? STRINGS[lang].net_online : STRINGS[lang].net_offline)}
      </span>

      <div className="flex items-center gap-1 bg-zinc-100 p-0.5 rounded-full">
        {(["es", "en"] as const).map((L) => (
          <button
            key={L}
            onClick={() => setLang(L)}
            className={cn(
              // 36px tall hit area (design handoff §7 touch targets) — the segment
              // pill grows to ~36px including the wrapper's p-0.5.
              "h-9 rounded-full text-xs font-medium",
              phone ? "px-2.5" : "px-3",
              lang === L
                ? "bg-white shadow-sm text-zinc-900"
                : "text-zinc-500",
            )}
          >
            {L.toUpperCase()}
          </button>
        ))}
      </div>

      {idleSec != null && idleSec < 30 && !phone && (
        <div className="text-xs text-amber-600 font-medium tabular-nums">
          {STRINGS[lang].pin_logout_auto.replace("{n}", String(idleSec))}
        </div>
      )}

      <button
        onClick={onLogout}
        className={cn(
          "flex items-center gap-2 rounded-full bg-zinc-100 active:bg-zinc-200",
          phone ? "h-10 pl-1 pr-2.5" : "h-12 pl-2 pr-4",
        )}
      >
        <div
          className={cn(
            "rounded-full flex items-center justify-center text-white font-semibold",
            phone ? "size-8 text-xs" : "size-9 text-sm",
          )}
          style={{ background: employee.color }}
        >
          {employee.initials}
        </div>
        {!phone && (
          <div className="text-left leading-tight">
            <div className="text-sm font-medium text-zinc-900">
              {employee.name.split(" ")[0]}
            </div>
            <div className="text-[10px] text-zinc-500">
              {STRINGS[lang].logout}
            </div>
          </div>
        )}
      </button>
    </div>
  );
}
