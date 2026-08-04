"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const TIMEZONES = [
  { value: "auto", label: "Auto — detect from POS" },
  { value: "America/Chicago", label: "America/Chicago (CT)" },
  { value: "America/New_York", label: "America/New_York (ET)" },
  { value: "America/Denver", label: "America/Denver (MT)" },
  { value: "America/Los_Angeles", label: "America/Los_Angeles (PT)" },
];

export interface StoreBasicsState {
  name: string;
  timezone: string;
  address: string;
}

interface StepBasicsProps {
  state: StoreBasicsState;
  onChange: (partial: Partial<StoreBasicsState>) => void;
}

export function StepBasics({ state, onChange }: StepBasicsProps) {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-[19px] font-semibold">Store basics</h2>
        <p className="mt-1 max-w-[460px] text-[13.5px] text-muted-foreground">
          Name your store. Time zone and address are optional — we can pull them from your POS once it&apos;s connected.
        </p>
      </div>

      <div className="max-w-[440px] space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="store-name" className="text-[13.5px]">
            Store name <span className="text-destructive">*</span>
          </Label>
          <Input
            id="store-name"
            placeholder="e.g. Mueller"
            value={state.name}
            onChange={(e) => onChange({ name: e.target.value })}
            className="h-10 rounded-[9px]"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="store-timezone" className="text-[13.5px]">
            Time zone <span className="text-[11px] text-muted-foreground font-normal">(optional)</span>
          </Label>
          <Select value={state.timezone} onValueChange={(v) => onChange({ timezone: v })}>
            <SelectTrigger id="store-timezone" className="h-10 rounded-[9px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TIMEZONES.map((tz) => (
                <SelectItem key={tz.value} value={tz.value}>
                  <span className={tz.value === "auto" ? "text-muted-foreground" : undefined}>
                    {tz.label}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="store-address" className="text-[13.5px]">
            Address <span className="text-[11px] text-muted-foreground font-normal">(optional)</span>
          </Label>
          <Input
            id="store-address"
            placeholder="Street, city, state"
            value={state.address}
            onChange={(e) => onChange({ address: e.target.value })}
            className="h-10 rounded-[9px]"
          />
        </div>
      </div>
    </div>
  );
}
