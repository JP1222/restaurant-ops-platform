"use client";

import Link from "next/link";
import {
  ArrowRight,
  Check,
  CreditCard,
  LayoutDashboard,
  Lock,
  PartyPopper,
  TrendingUp,
  Users,
  UtensilsCrossed,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { SquareEnvironment } from "@rop/contracts";
import type { CatalogImportResult } from "./step-import";

interface StepFinishProps {
  storeName: string;
  platform: "clover" | "square";
  env: SquareEnvironment;
  importResult: CatalogImportResult | null;
  locationCount: number;
}

const CAPABILITIES = [
  {
    icon: LayoutDashboard,
    label: "KDS",
    sub: "Kitchen display",
    enabled: true,
  },
  {
    icon: UtensilsCrossed,
    label: "Inventory",
    sub: "Stock & counts",
    enabled: true,
  },
  {
    icon: Users,
    label: "Crew",
    sub: "Staff & scheduling",
    enabled: true,
  },
  {
    icon: UtensilsCrossed,
    label: "Menu",
    sub: "Catalog sync",
    enabled: true,
  },
  {
    icon: TrendingUp,
    label: "Analytics",
    sub: "Sales & insights",
    enabled: true,
  },
  {
    icon: CreditCard,
    label: "Online ordering & checkout",
    sub: "Not part of this release",
    enabled: false,
    pill: "Coming later",
  },
] as const;

export function StepFinish({ storeName, platform, env, importResult, locationCount }: StepFinishProps) {
  return (
    <div className="max-w-[560px] space-y-6">
      <div className="flex items-center gap-4">
        <span className="flex size-[52px] shrink-0 items-center justify-center rounded-xl bg-accent-soft">
          <PartyPopper className="size-6 text-accent" />
        </span>
        <div>
          <h2 className="text-[22px] font-semibold">{storeName} is connected</h2>
          <p className="text-[13.5px] text-muted-foreground">
            Your POS is linked and your menu is in. Here&apos;s what&apos;s switched on for this store.
          </p>
        </div>
      </div>

      {/* Capability list */}
      <div className="overflow-hidden rounded-[14px] border bg-card">
        {CAPABILITIES.map((cap, i) => {
          return (
            <div
              key={cap.label}
              className={`flex items-center gap-3 px-4 py-3 text-[13px] ${i < CAPABILITIES.length - 1 ? "border-b" : ""}`}
            >
              <span
                className={`flex size-[30px] shrink-0 items-center justify-center rounded-lg ${cap.enabled ? "bg-accent-soft" : "bg-muted"}`}
              >
                {cap.enabled ? (
                  <Check className="size-3.5 text-accent" />
                ) : (
                  <Lock className="size-3.5 text-muted-foreground" />
                )}
              </span>
              <div className="flex-1">
                <span className={`font-semibold ${cap.enabled ? "" : "text-muted-foreground"}`}>
                  {cap.label}
                </span>
                <span className="ml-2 text-[12px] text-muted-foreground">{cap.sub}</span>
              </div>
              {"pill" in cap && cap.pill && (
                <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                  {cap.pill}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Summary chips */}
      <div className="flex flex-wrap gap-2">
        <span className="rounded-full bg-muted px-3 py-1 text-[12px] text-muted-foreground">
          {platform === "square" ? "Square" : "Clover"} · {env}
        </span>
        <span className="rounded-full bg-muted px-3 py-1 text-[12px] text-muted-foreground">
          {locationCount} location{locationCount !== 1 ? "s" : ""}
        </span>
        {importResult && (
          <span className="rounded-full bg-muted px-3 py-1 text-[12px] text-muted-foreground">
            {importResult.itemCount} items imported
          </span>
        )}
      </div>

      <Button asChild size="default" className="h-[42px] rounded-[9px]">
        <Link href="/settings/stores">
          Go to store
          <ArrowRight className="ml-2 size-4" />
        </Link>
      </Button>
    </div>
  );
}
