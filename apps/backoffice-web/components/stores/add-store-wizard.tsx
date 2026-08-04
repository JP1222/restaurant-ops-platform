"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, LoaderCircle, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useCreateLocation } from "@/hooks/use-locations";
import { useBindMerchant } from "@/hooks/use-locations";
import { useConnectSquare } from "@/hooks/use-square";
import type { StoreBasicsState } from "./step-basics";
import { StepBasics } from "./step-basics";
import type { Platform } from "./step-platform";
import { StepPlatform } from "./step-platform";
import type { SquareConnectState } from "./step-connect-square";
import { StepConnectSquare } from "./step-connect-square";
import type { ImportStepState } from "./step-import";
import { StepImport } from "./step-import";
import { StepFinish } from "./step-finish";
import { WizardStepper } from "./wizard-stepper";

const TOTAL_STEPS = 5;

interface WizardState {
  basics: StoreBasicsState;
  platform: Platform | null;
  squareConnect: SquareConnectState;
  importStep: ImportStepState;
  createdLocationId: string | null;
  connectResult: { merchantId: string; merchantName: string; stores: { posStoreId: string; name: string }[] } | null;
}

function initialState(): WizardState {
  return {
    basics: { name: "", timezone: "auto", address: "" },
    platform: null,
    squareConnect: {
      env: "sandbox",
      token: "",
      testState: "idle",
      testError: null,
      testResult: null,
      selectedLocationId: null,
    },
    importStep: { importState: "idle", importResult: null },
    createdLocationId: null,
    connectResult: null,
  };
}

function canProceed(step: number, state: WizardState): { ok: boolean; hint: string } {
  switch (step) {
    case 1:
      return state.basics.name.trim()
        ? { ok: true, hint: "" }
        : { ok: false, hint: "Enter a store name to continue." };
    case 2:
      return state.platform
        ? { ok: true, hint: "" }
        : { ok: false, hint: "Choose a POS to continue." };
    case 3:
      if (state.platform === "square") {
        const ready =
          state.squareConnect.testState === "success" &&
          state.squareConnect.selectedLocationId !== null;
        return ready
          ? { ok: true, hint: "" }
          : { ok: false, hint: "Test the connection and choose a location." };
      }
      // Clover not yet connected
      return { ok: false, hint: "Connect Clover to continue." };
    case 4:
      return { ok: true, hint: "" };
    default:
      return { ok: true, hint: "" };
  }
}

export function AddStoreWizard() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [state, setState] = useState<WizardState>(initialState);
  const [finishing, setFinishing] = useState(false);

  const createLocation = useCreateLocation();
  const connectSquare = useConnectSquare();
  const bindMerchant = useBindMerchant();

  const update = <K extends keyof WizardState>(key: K, value: WizardState[K]) => {
    setState((s) => ({ ...s, [key]: value }));
  };

  const { ok: canContinue, hint } = canProceed(step, state);

  const handleBack = () => {
    if (step > 1) setStep((s) => s - 1);
  };

  const handleContinue = async () => {
    if (!canContinue) return;

    // Step 1 → 2: create the Location
    if (step === 1) {
      try {
        const tz = state.basics.timezone === "auto" ? "America/Chicago" : state.basics.timezone;
        const res = await createLocation.mutateAsync({ name: state.basics.name.trim(), timezone: tz });
        update("createdLocationId", res.location.id);
        setStep(2);
      } catch {
        toast.error("Could not create store — try again.");
      }
      return;
    }

    // Step 3 → 4: run Square connect + bind
    if (step === 3 && state.platform === "square") {
      setFinishing(true);
      try {
        const connectRes = await connectSquare.mutateAsync({
          accessToken: state.squareConnect.token,
          environment: state.squareConnect.env,
        });
        update("connectResult", {
          merchantId: connectRes.merchantId,
          merchantName: connectRes.merchantName,
          stores: connectRes.stores,
        });

        // Bind the selected location's posStoreId to our new Location
        const selectedStore = connectRes.stores.find(
          (s) => {
            // posStoreId is `square:{providerStoreId}`, providerStoreId === locationId in test result
            const lid = state.squareConnect.selectedLocationId;
            return s.posStoreId === `square:${lid}` || s.posStoreId.endsWith(`:${lid}`);
          },
        );
        if (selectedStore && state.createdLocationId) {
          await bindMerchant.mutateAsync({
            locationId: state.createdLocationId,
            merchantId: selectedStore.posStoreId,
          });
        }
        setStep(4);
      } catch {
        toast.error("Could not connect to Square — try again.");
      } finally {
        setFinishing(false);
      }
      return;
    }

    if (step < TOTAL_STEPS) {
      setStep((s) => s + 1);
    }
  };

  const handleStepClick = (target: number) => {
    if (target < step) setStep(target);
  };

  const isLastStep = step === TOTAL_STEPS;
  const isLoading = createLocation.isPending || finishing;

  const locationCount = state.squareConnect.testResult?.locations.length ?? 1;

  // The bound store's PosStore id, for the live catalog import in step 4 (mirrors
  // the bind matcher above).
  const selectedPosStoreId =
    state.connectResult?.stores.find((s) => {
      const lid = state.squareConnect.selectedLocationId;
      return s.posStoreId === `square:${lid}` || s.posStoreId.endsWith(`:${lid}`);
    })?.posStoreId ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-secondary/30">
      {/* Wizard top bar */}
      <div className="flex shrink-0 items-center justify-between border-b bg-card px-6 py-3">
        <div>
          <span className="text-[15px] font-semibold">Add store</span>
          <span className="ml-2 text-[13px] text-muted-foreground">/settings/stores/new</span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-[34px] rounded-lg"
          onClick={() => router.push("/settings/stores")}
          aria-label="Close wizard"
        >
          <X className="size-4" />
        </Button>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[940px] px-7 pb-11 pt-[34px]">
          {/* Mobile stepper */}
          <div className="mb-6 md:hidden">
            <WizardStepper currentStep={step} onStepClick={handleStepClick} />
          </div>

          <div className="flex gap-10">
            {/* Desktop left rail stepper */}
            <div className="hidden w-[180px] shrink-0 md:block">
              <div className="sticky top-5">
                <WizardStepper currentStep={step} onStepClick={handleStepClick} />
              </div>
            </div>

            {/* Step content */}
            <div className="min-w-0 flex-1">
              {step === 1 && (
                <StepBasics
                  state={state.basics}
                  onChange={(partial) => update("basics", { ...state.basics, ...partial })}
                />
              )}
              {step === 2 && (
                <StepPlatform
                  value={state.platform}
                  onChange={(p) => {
                    update("platform", p);
                    // Reset connect state when platform changes
                    update("squareConnect", initialState().squareConnect);
                  }}
                />
              )}
              {step === 3 && state.platform === "square" && (
                <StepConnectSquare
                  state={state.squareConnect}
                  onChange={(partial) =>
                    update("squareConnect", { ...state.squareConnect, ...partial })
                  }
                />
              )}
              {step === 3 && state.platform === "clover" && (
                <div className="max-w-[540px] space-y-5">
                  <div>
                    <h2 className="text-[19px] font-semibold">Connect Clover</h2>
                    <p className="mt-1 text-[13.5px] text-muted-foreground">
                      Authorize Example Kitchen to access your Clover account.
                    </p>
                  </div>
                  <div className="flex flex-col items-start gap-3 rounded-[14px] border bg-card p-5">
                    <span className="flex size-[44px] items-center justify-center rounded-xl bg-accent-soft font-mono text-xl font-semibold text-trend-up">
                      C
                    </span>
                    <div>
                      <p className="text-[14px] font-semibold">Connect with Clover</p>
                      <p className="mt-0.5 text-[13px] text-muted-foreground">
                        You&apos;ll be sent to Clover to authorize access, then returned here. No tokens to copy.
                      </p>
                    </div>
                    <Button className="h-10 rounded-[9px]">
                      Connect Clover
                    </Button>
                  </div>
                </div>
              )}
              {step === 4 && (
                <StepImport
                  state={state.importStep}
                  platform={state.platform ?? "square"}
                  posStoreId={selectedPosStoreId}
                  onChange={(partial) =>
                    update("importStep", { ...state.importStep, ...partial })
                  }
                />
              )}
              {step === 5 && (
                <StepFinish
                  storeName={state.basics.name}
                  platform={state.platform ?? "square"}
                  env={state.squareConnect.env}
                  importResult={state.importStep.importResult}
                  locationCount={locationCount}
                />
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Footer (hidden on finish step) */}
      {!isLastStep && (
        <div className="shrink-0 border-t bg-card px-7 pb-6 pt-5">
          <div className="mx-auto flex max-w-[940px] items-center gap-4">
            <Button
              variant="outline"
              onClick={handleBack}
              disabled={step === 1}
              className={`h-10 rounded-[9px] ${step === 1 ? "invisible" : ""}`}
            >
              <ArrowLeft className="mr-2 size-4" />
              Back
            </Button>
            <div className="flex-1" />
            {!canContinue && hint && (
              <span className="text-right text-[13px] text-muted-foreground">{hint}</span>
            )}
            <Button
              onClick={handleContinue}
              disabled={!canContinue || isLoading}
              className="h-10 rounded-[9px]"
            >
              {isLoading ? (
                <LoaderCircle className="mr-2 size-4 animate-spin" />
              ) : (
                <ArrowRight className="mr-2 size-4" />
              )}
              {step === TOTAL_STEPS - 1 ? "Finish" : "Continue"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
