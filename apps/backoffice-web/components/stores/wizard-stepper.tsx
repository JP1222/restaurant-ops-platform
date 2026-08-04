"use client";

import { Check } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

export const WIZARD_STEPS = [
  { id: 1, label: "Store basics" },
  { id: 2, label: "Platform" },
  { id: 3, label: "Connect" },
  { id: 4, label: "Import data" },
  { id: 5, label: "Finish" },
] as const;

interface WizardStepperProps {
  currentStep: number;
  onStepClick?: (step: number) => void;
}

export function WizardStepper({ currentStep, onStepClick }: WizardStepperProps) {
  return (
    <>
      {/* Desktop: vertical numbered rail */}
      <div className="hidden flex-col gap-0 md:flex">
        {WIZARD_STEPS.map((step, i) => {
          const done = currentStep > step.id;
          const current = currentStep === step.id;
          const todo = currentStep < step.id;
          const isLast = i === WIZARD_STEPS.length - 1;

          return (
            <div key={step.id} className="flex items-start gap-3">
              {/* Circle + connector column */}
              <div className="flex flex-col items-center">
                <button
                  type="button"
                  onClick={() => onStepClick?.(step.id)}
                  disabled={todo}
                  className={cn(
                    "flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold transition-colors",
                    done && "bg-accent text-white",
                    current && "bg-accent text-white",
                    todo && "border border-border text-muted-foreground",
                    todo ? "cursor-not-allowed" : "cursor-pointer",
                  )}
                  aria-current={current ? "step" : undefined}
                >
                  {done ? <Check className="size-3.5" /> : step.id}
                </button>
                {!isLast && (
                  <div
                    className={cn(
                      "my-1 h-6 w-px",
                      done ? "bg-accent" : "bg-border",
                    )}
                  />
                )}
              </div>
              {/* Label */}
              <span
                className={cn(
                  "pt-0.5 text-[13px]",
                  current && "font-semibold text-foreground",
                  (done || todo) && "text-muted-foreground",
                )}
              >
                {step.label}
              </span>
            </div>
          );
        })}
      </div>

      {/* Mobile: Step X of 5 + progress bar */}
      <div className="md:hidden">
        <div className="flex items-baseline justify-between">
          <span className="text-[14px] font-semibold">Step {currentStep} of {WIZARD_STEPS.length}</span>
          <span className="text-[13px] text-muted-foreground">{WIZARD_STEPS[currentStep - 1]?.label}</span>
        </div>
        <Progress
          value={(currentStep / WIZARD_STEPS.length) * 100}
          className="mt-2 h-1 rounded-full"
        />
      </div>
    </>
  );
}
