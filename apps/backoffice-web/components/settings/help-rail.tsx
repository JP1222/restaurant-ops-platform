import { ChevronRight, Info, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import type { SectionHelp } from "./settings-nav-data";

// Contextual right rail for form-style sections. Stays sticky beside the form
// and wraps below it under ~1100px (the parent controls the flex-wrap).
export function HelpRail({ help }: { help: SectionHelp }) {
  const danger = help.tone === "danger";
  return (
    <aside
      className="sticky top-0 flex flex-col gap-3.5"
      style={{ flex: "1 1 240px", minWidth: 220, maxWidth: 300 }}
    >
      <div
        className={cn(
          "rounded-lg border p-4",
          danger ? "border-destructive/30 bg-destructive-soft" : "border-border bg-secondary"
        )}
      >
        <div className="mb-2 flex items-center gap-2">
          {danger ? (
            <TriangleAlert className="size-4 text-destructive" />
          ) : (
            <Info className="size-4 text-accent" />
          )}
          <span
            className={cn(
              "text-xs font-semibold tracking-wide uppercase",
              danger ? "text-destructive" : "text-muted-foreground"
            )}
          >
            {danger ? "Heads up" : "About this section"}
          </span>
        </div>
        <p className={cn("text-sm leading-relaxed", danger ? "text-destructive/90" : "text-muted-foreground")}>
          {help.tip}
        </p>
      </div>

      {help.links?.length ? (
        <div className="rounded-lg border p-1.5">
          {help.links.map((link) => {
            const inner = (
              <>
                <link.icon className="size-4 text-muted-foreground" />
                <span className="flex-1 text-left">{link.label}</span>
                <ChevronRight className="size-3.5 text-muted-foreground" />
              </>
            );
            const className =
              "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors hover:bg-secondary";
            return link.href ? (
              <Link key={link.label} href={link.href} className={className}>
                {inner}
              </Link>
            ) : (
              <button key={link.label} type="button" className={className}>
                {inner}
              </button>
            );
          })}
        </div>
      ) : null}
    </aside>
  );
}
