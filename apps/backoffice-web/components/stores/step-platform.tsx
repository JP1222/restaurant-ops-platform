"use client";

import { CircleCheckBig, Lock } from "lucide-react";
import { cn } from "@/lib/utils";

export type Platform = "clover" | "square";

interface StepPlatformProps {
  value: Platform | null;
  onChange: (platform: Platform) => void;
}

const PLATFORMS = [
  {
    id: "clover" as Platform,
    letter: "C",
    name: "Clover",
    subtitle: "Connect with OAuth",
    letterClass: "bg-accent-soft text-trend-up",
  },
  {
    id: "square" as Platform,
    letter: "S",
    name: "Square",
    subtitle: "Access token",
    letterClass: "bg-info-soft text-info-foreground",
  },
] as const;

export function StepPlatform({ value, onChange }: StepPlatformProps) {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-[19px] font-semibold">Choose your POS</h2>
        <p className="mt-1 text-[13.5px] text-muted-foreground">
          We&apos;ll pull your menu and sales from here.
        </p>
      </div>

      <div className="grid max-w-[540px] grid-cols-1 gap-3 sm:grid-cols-3">
        {PLATFORMS.map((p) => {
          const selected = value === p.id;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => onChange(p.id)}
              className={cn(
                "relative flex flex-col items-start gap-3 rounded-xl border-2 p-4 text-left transition-colors",
                selected
                  ? "border-accent bg-accent-soft"
                  : "border-border bg-card hover:border-accent/40 hover:bg-accent-soft/40",
              )}
            >
              {selected && (
                <CircleCheckBig className="absolute right-3 top-3 size-4 text-accent" />
              )}
              <span
                className={cn(
                  "flex size-[42px] items-center justify-center rounded-[10px] font-mono text-lg font-semibold",
                  p.letterClass,
                )}
              >
                {p.letter}
              </span>
              <div>
                <p className="text-[13.5px] font-semibold">{p.name}</p>
                <p className="text-[12px] text-muted-foreground">{p.subtitle}</p>
              </div>
            </button>
          );
        })}

        {/* Locked "More coming soon" card */}
        <div className="relative flex flex-col items-start gap-3 rounded-xl border-2 border-border bg-card p-4 opacity-55">
          <Lock className="absolute right-3 top-3 size-3.5 text-muted-foreground" />
          <span className="flex size-[42px] items-center justify-center rounded-[10px] bg-muted font-mono text-lg font-semibold text-muted-foreground">
            +
          </span>
          <div>
            <p className="text-[13.5px] font-semibold text-muted-foreground">More coming soon</p>
            <p className="text-[12px] text-muted-foreground">Toast · Lightspeed</p>
          </div>
        </div>
      </div>
    </div>
  );
}
