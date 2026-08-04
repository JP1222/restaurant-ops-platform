"use client";

import { Search } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { SETTINGS_NAV, SETTINGS_NAV_FLAT, type SettingsNavItem } from "./settings-nav-data";

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavLink({ item, active }: { item: SettingsNavItem; active: boolean }) {
  const danger = item.tone === "danger";
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group/nav relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors",
        active ? "bg-secondary text-foreground" : "text-foreground hover:bg-sidebar-accent"
      )}
    >
      <span
        className={cn(
          "absolute top-1/2 left-0 h-4 w-[3px] -translate-y-1/2 rounded-full transition-opacity",
          active ? "opacity-100" : "opacity-0",
          danger ? "bg-destructive" : "bg-accent"
        )}
      />
      <item.icon
        className={cn(
          "size-4 transition-colors",
          active
            ? danger
              ? "text-destructive"
              : "text-accent"
            : "text-muted-foreground group-hover/nav:text-foreground"
        )}
      />
      <span className="flex-1">{item.label}</span>
      {item.badge ? (
        <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent">
          <span className="size-1.5 rounded-full bg-accent" />
          {item.badge}
        </span>
      ) : null}
    </Link>
  );
}

export function SettingsNav() {
  const pathname = usePathname();
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();

  const matches = (item: SettingsNavItem) =>
    !q || item.label.toLowerCase().includes(q) || item.desc.toLowerCase().includes(q);

  return (
    <>
      {/* Desktop rail */}
      <div className="hidden w-62 shrink-0 flex-col border-r bg-sidebar md:flex">
        <div className="px-4 pt-4 pb-2.5">
          <h2 className="mb-3 text-lg font-semibold tracking-tight">Settings</h2>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search settings"
              aria-label="Search settings"
              className="h-9 bg-background pl-9"
            />
          </div>
        </div>
        <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-3 pb-4">
          {SETTINGS_NAV.map((group) => {
            const items = group.items.filter(matches);
            if (!items.length) return null;
            return (
              <div key={group.group}>
                <div className="px-2.5 pt-3.5 pb-1.5 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                  {group.group}
                </div>
                {items.map((item) => (
                  <NavLink key={item.id} item={item} active={isActive(pathname, item.href)} />
                ))}
              </div>
            );
          })}
        </nav>
      </div>

      {/* Mobile strip */}
      <div className="flex gap-1.5 overflow-x-auto border-b bg-sidebar p-2 md:hidden">
        {SETTINGS_NAV_FLAT.map((item) => {
          const active = isActive(pathname, item.href);
          const danger = item.tone === "danger";
          return (
            <Link
              key={item.id}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors",
                active ? "bg-secondary" : "text-muted-foreground hover:bg-sidebar-accent"
              )}
            >
              <item.icon
                className={cn("size-4", active ? (danger ? "text-destructive" : "text-accent") : "")}
              />
              {item.label}
            </Link>
          );
        })}
      </div>
    </>
  );
}
