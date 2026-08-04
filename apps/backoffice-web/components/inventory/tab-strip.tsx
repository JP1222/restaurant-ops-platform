"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

export interface Tab {
  id: string;
  label: string;
}

export interface TabStripProps {
  active: string;
  tabs: Tab[];
  onChange: (id: string) => void;
}

export function TabStrip({ active, tabs, onChange }: TabStripProps) {
  const ref = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>('[data-active="true"]');
    if (el && ref.current) {
      const left = el.offsetLeft - 16;
      ref.current.scrollTo({ left, behavior: "smooth" });
    }
  }, [active]);

  return (
    <div
      ref={ref}
      className="sticky top-0 z-20 -mx-6 overflow-x-auto border-b border-border bg-background/95 px-6 backdrop-blur supports-backdrop-filter:bg-background/80 lg:-mx-8 lg:px-8"
    >
      <div className="flex min-w-max items-center gap-1">
        {tabs.map((t) => (
          <button
            key={t.id}
            data-active={active === t.id}
            onClick={() => onChange(t.id)}
            className={cn(
              "relative h-10 whitespace-nowrap px-3 text-sm font-medium transition-colors sm:h-9",
              active === t.id
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {t.label}
            {active === t.id && (
              <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-foreground" />
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
