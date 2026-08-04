"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronsUpDown, Plus, Settings, Store } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useLocations } from "@/hooks/use-locations";
import { ACTIVE_LOCATION_COOKIE, ALL_STORES } from "@/lib/location/constants";

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  const captured = match?.[1];
  return captured === undefined ? null : decodeURIComponent(captured);
}

function writeCookie(name: string, value: string): void {
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=31536000; samesite=lax`;
}

// Brand-wide store selector. Persists the active store to a cookie so analytics
// scope can pick it up (Phase 3, ADR-0018). Always visible — provides the
// "+ Add store" and "Manage stores" navigation even in single-store deployments.
export function StoreSwitcher() {
  const router = useRouter();
  const { data } = useLocations();
  const [active, setActive] = useState<string>(() => readCookie(ACTIVE_LOCATION_COOKIE) ?? ALL_STORES);

  const locations = data?.locations ?? [];

  const activeLocation = locations.find((l) => l.id === active);
  const label = activeLocation?.name ?? (locations.length === 1 ? (locations[0]?.name ?? "Store") : "All stores");

  const handleSelect = (id: string) => {
    setActive(id);
    writeCookie(ACTIVE_LOCATION_COOKIE, id);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="flex h-[38px] items-center gap-2 rounded-[9px] border bg-card px-3 text-sm font-semibold transition-colors hover:bg-accent-soft data-[state=open]:border-accent data-[state=open]:bg-accent-soft"
          aria-label="Switch store"
        >
          <Store className="size-4 shrink-0 text-muted-foreground" />
          <span className="max-w-[120px] truncate">{label}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-[290px] rounded-xl border p-1.5 shadow-[0_16px_44px_var(--color-border)]"
      >
        {locations.length > 0 && (
          <>
            <DropdownMenuLabel className="px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">
              Your stores
            </DropdownMenuLabel>
            {locations.length >= 2 && (
              <DropdownMenuItem
                className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13.5px]"
                onSelect={() => handleSelect(ALL_STORES)}
              >
                <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-semibold font-mono">
                  All
                </span>
                <span className="flex-1 font-semibold">All stores</span>
                {active === ALL_STORES && <Check className="size-3.5 text-accent" />}
              </DropdownMenuItem>
            )}
            {locations.map((loc) => (
              <DropdownMenuItem
                key={loc.id}
                className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13.5px] data-[highlighted]:bg-accent-soft"
                onSelect={() => handleSelect(loc.id)}
              >
                <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-accent-soft font-mono text-xs font-semibold text-accent">
                  {loc.name[0]?.toUpperCase() ?? "S"}
                </span>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-semibold">{loc.name}</span>
                  {loc.timezone && (
                    <span className="truncate text-[11.5px] text-muted-foreground">{loc.timezone}</span>
                  )}
                </div>
                {active === loc.id && <Check className="size-3.5 shrink-0 text-accent" />}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator className="my-1.5" />
          </>
        )}
        <DropdownMenuItem
          className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13.5px] text-accent"
          onSelect={() => router.push("/settings/stores/new")}
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-accent-soft">
            <Plus className="size-3.5 text-accent" />
          </span>
          <span className="font-semibold">Add store</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] text-muted-foreground"
          onSelect={() => router.push("/settings/stores")}
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted">
            <Settings className="size-3.5" />
          </span>
          <span>Manage stores</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
