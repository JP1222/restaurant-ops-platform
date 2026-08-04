"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSetLaborCost } from "@/hooks/use-set-labor-cost";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface LaborCostDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Operator labor-cost editor (ADR-0033, Phase 4b). The operator enters an all-in
 * weekly labor bill + days open; we model it per operating day (the shape the prime
 * cost mart joins on) and POST it through the costs BFF. On success the costs query is
 * invalidated, so the Labor % + Prime cost cards refetch and light up.
 */
export function LaborCostDialog({ open, onOpenChange }: LaborCostDialogProps) {
  const [weekly, setWeekly] = useState("");
  const [daysOpen, setDaysOpen] = useState("6");
  const [effectiveFrom, setEffectiveFrom] = useState(todayIso());
  const mutation = useSetLaborCost();

  const weeklyNum = Number(weekly);
  const daysNum = Number(daysOpen);
  const valid =
    Number.isFinite(weeklyNum) &&
    weeklyNum > 0 &&
    Number.isInteger(daysNum) &&
    daysNum >= 1 &&
    daysNum <= 7 &&
    /^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom);

  // All-in weekly labor bill modeled per operating day (ADR-0033). Not rounded, so a
  // weekly figure spread across days keeps sub-cent precision rather than truncating.
  const dailyCents = valid ? (weeklyNum * 100) / daysNum : 0;

  async function handleSave() {
    if (!valid) return;
    const note = `$${weeklyNum.toLocaleString("en-US")}/wk ÷ ${daysNum} days open`;
    try {
      await mutation.mutateAsync({
        daily_labor_cost_cents: dailyCents,
        currency: "USD",
        effective_from: effectiveFrom,
        note
      });
      toast.success("Labor cost saved. Prime cost will update shortly.");
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save labor cost");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Set labor cost</DialogTitle>
          <DialogDescription>
            Enter your all-in weekly labor bill (wages, taxes, benefits) and how many days
            you&apos;re open. We model it per operating day to compute labor % and prime cost. A
            wage change later opens a new effective-dated entry, so past numbers stay correct.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="labor-weekly">Weekly labor cost ($)</Label>
              <Input
                id="labor-weekly"
                inputMode="decimal"
                placeholder="2800"
                value={weekly}
                onChange={(event) => setWeekly(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="labor-days">Days open / week</Label>
              <Input
                id="labor-days"
                inputMode="numeric"
                placeholder="6"
                value={daysOpen}
                onChange={(event) => setDaysOpen(event.target.value)}
              />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="labor-effective">Effective from</Label>
            <Input
              id="labor-effective"
              type="date"
              value={effectiveFrom}
              onChange={(event) => setEffectiveFrom(event.target.value)}
            />
          </div>
          <p className="rounded-md bg-muted/50 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
            {valid ? (
              <>
                Modeled at{" "}
                <span className="font-mono font-medium tabular-nums text-foreground">
                  ${(dailyCents / 100).toFixed(2)}
                </span>{" "}
                per operating day. Labor % = daily labor cost / net sales.
              </>
            ) : (
              "Enter a weekly cost and 1-7 days open to preview the per-day figure."
            )}
          </p>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={mutation.isPending}
          >
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!valid || mutation.isPending}>
            {mutation.isPending ? "Saving" : "Save labor cost"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
