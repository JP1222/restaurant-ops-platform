"use client";

import { useState } from "react";
import {
  CircleAlert,
  ClipboardIcon,
  Eye,
  EyeOff,
  LoaderCircle,
  ShieldCheck,
  TriangleAlert,
  Unplug,
  WifiOff,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { SquareEnvironment, SquareLocationSummary } from "@rop/contracts";
import { cn } from "@/lib/utils";
import { useTestSquareConnection } from "@/hooks/use-square";

export type TestState = "idle" | "testing" | "success" | "error";
export type TestError = "token" | "env" | "timeout" | "no_locations" | "scope" | "generic";

export interface SquareConnectState {
  env: SquareEnvironment;
  token: string;
  testState: TestState;
  testError: TestError | null;
  testResult: { merchantName: string; merchantId: string; locations: SquareLocationSummary[] } | null;
  selectedLocationId: string | null;
}

interface StepConnectSquareProps {
  state: SquareConnectState;
  onChange: (partial: Partial<SquareConnectState>) => void;
}

function envLabel(env: SquareEnvironment) {
  return env === "production" ? "Production" : "Sandbox";
}

function otherEnv(env: SquareEnvironment): SquareEnvironment {
  return env === "production" ? "sandbox" : "production";
}

function errorKindToTestError(kind: string): TestError {
  switch (kind) {
    case "invalid_token": return "token";
    case "timeout": return "timeout";
    case "no_locations": return "no_locations";
    case "insufficient_scope": return "scope";
    default: return "generic";
  }
}

export function StepConnectSquare({ state, onChange }: StepConnectSquareProps) {
  const [showToken, setShowToken] = useState(false);
  const testMutation = useTestSquareConnection();

  const handleEnvChange = (env: SquareEnvironment) => {
    onChange({ env, testState: "idle", testError: null, testResult: null, selectedLocationId: null });
  };

  const handleTokenChange = (value: string) => {
    onChange({ token: value, testState: "idle", testError: null, testResult: null, selectedLocationId: null });
  };

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      handleTokenChange(text.trim());
    } catch {
      // clipboard not available — user can paste manually
    }
  };

  const handleTest = async () => {
    if (!state.token) return;
    onChange({ testState: "testing", testError: null, testResult: null, selectedLocationId: null });
    try {
      const result = await testMutation.mutateAsync({ accessToken: state.token, environment: state.env });
      const autoSelect = result.locations.length === 1 ? result.locations[0]?.id ?? null : null;
      onChange({
        testState: "success",
        testResult: { merchantName: result.merchantName, merchantId: result.merchantId, locations: result.locations },
        selectedLocationId: autoSelect,
      });
    } catch (err: unknown) {
      const kind = err instanceof Error ? err.message : "generic";
      onChange({ testState: "error", testError: errorKindToTestError(kind), testResult: null, selectedLocationId: null });
    }
  };

  const handleClear = () => {
    onChange({ token: "", testState: "idle", testError: null, testResult: null, selectedLocationId: null });
    setShowToken(false);
  };

  const handleSwitchEnv = () => {
    onChange({
      env: otherEnv(state.env),
      testState: "idle",
      testError: null,
      testResult: null,
      selectedLocationId: null,
    });
  };

  const hasSuccessAndLocation = state.testState === "success" && state.selectedLocationId !== null;

  return (
    <div className="max-w-[540px] space-y-6">
      <div>
        <h2 className="text-[19px] font-semibold">Connect Square</h2>
        <p className="mt-1 text-[13.5px] text-muted-foreground">
          Paste your Square access token. We&apos;ll verify it and show your locations.
        </p>
      </div>

      {/* Environment toggle */}
      <div className="space-y-1.5">
        <Label className="text-[13.5px]">Environment</Label>
        <div className="flex h-10 rounded-[9px] border bg-muted p-0.5">
          {(["sandbox", "production"] as SquareEnvironment[]).map((env) => (
            <button
              key={env}
              type="button"
              onClick={() => handleEnvChange(env)}
              className={cn(
                "flex-1 rounded-[7px] text-[13px] font-medium transition-all",
                state.env === env
                  ? "bg-card shadow-sm text-foreground font-semibold"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {envLabel(env)}
            </button>
          ))}
        </div>
        <p className="text-[12px] text-muted-foreground">
          {state.env === "production"
            ? "Your live Square account — choose this for a real store."
            : "Square's test account — safe for trying the flow without live data."}
        </p>
      </div>

      {/* Token input */}
      <div className="space-y-1.5">
        <Label htmlFor="square-token" className="text-[13.5px]">
          Access token <span className="text-destructive">*</span>
        </Label>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Input
              id="square-token"
              type={showToken ? "text" : "password"}
              value={state.token}
              onChange={(e) => handleTokenChange(e.target.value)}
              placeholder="Paste your Square access token"
              className="h-10 rounded-[9px] pr-20 font-mono text-sm"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
            />
            <div className="absolute inset-y-0 right-2 flex items-center gap-1">
              <button
                type="button"
                onClick={() => setShowToken((s) => !s)}
                className="rounded p-1 text-muted-foreground hover:text-foreground"
                aria-label={showToken ? "Hide token" : "Show token"}
              >
                {showToken ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              </button>
              <button
                type="button"
                onClick={handlePaste}
                className="rounded p-1 text-muted-foreground hover:text-foreground"
                aria-label="Paste from clipboard"
              >
                <ClipboardIcon className="size-3.5" />
              </button>
            </div>
          </div>
        </div>
        <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
          <ShieldCheck className="size-3.5 shrink-0 text-accent" />
          Stored write-only — we never display your token again.
        </p>
      </div>

      {/* Test connection button */}
      <div className="space-y-2">
        <Button
          type="button"
          onClick={handleTest}
          disabled={!state.token || state.testState === "testing"}
          className="h-10 rounded-[9px]"
        >
          {state.testState === "testing" ? (
            <>
              <LoaderCircle className="mr-2 size-4 animate-spin" />
              Testing…
            </>
          ) : state.testState === "success" ? (
            "Test again"
          ) : (
            "Test connection"
          )}
        </Button>
        {state.testState === "idle" && (
          <p className="text-[12px] text-muted-foreground">
            Run a test before continuing — we&apos;ll confirm your merchant and pull locations.
          </p>
        )}
      </div>

      {/* Result: success */}
      {state.testState === "success" && state.testResult && (
        <div className="space-y-3 rounded-xl border border-accent bg-accent-soft p-4">
          <div className="flex items-center gap-3">
            <span className="flex size-[30px] shrink-0 items-center justify-center rounded-full bg-accent text-white">
              <svg viewBox="0 0 14 14" className="size-3.5 fill-current">
                <path d="M11.5 3.5 5.5 9.5 2.5 6.5" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <div className="flex flex-1 flex-wrap items-center gap-2">
              <span className="text-[13.5px] font-semibold">Connected to {state.testResult.merchantName}</span>
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-[11px] font-semibold",
                  state.env === "production"
                    ? "bg-info-soft text-info-foreground"
                    : "bg-warn-soft text-warn-foreground",
                )}
              >
                {envLabel(state.env)}
              </span>
            </div>
          </div>

          {/* Location select */}
          <div className="rounded-lg border bg-card p-3">
            <p className="mb-2.5 text-[12px] font-semibold text-muted-foreground uppercase tracking-[0.04em]">
              Select a location <span className="text-destructive">*</span>
            </p>
            {state.testResult.locations.length === 1 ? (
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-[13.5px] font-semibold">{state.testResult.locations[0]!.name}</p>
                  <p className="text-[11.5px] text-muted-foreground">
                    {state.testResult.locations[0]!.timezone} · {state.testResult.locations[0]!.currency}
                  </p>
                </div>
                <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] text-trend-up">
                  Only location — selected
                </span>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-[12px] text-muted-foreground">
                  Choose which location this store maps to.
                </p>
                {state.testResult.locations.map((loc) => (
                  <button
                    key={loc.id}
                    type="button"
                    onClick={() => onChange({ selectedLocationId: loc.id })}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors",
                      state.selectedLocationId === loc.id
                        ? "border-accent bg-accent-soft"
                        : "border-border hover:border-accent/40",
                    )}
                  >
                    <span
                      className={cn(
                        "flex size-[18px] shrink-0 items-center justify-center rounded-full border-2 transition-colors",
                        state.selectedLocationId === loc.id
                          ? "border-accent bg-accent"
                          : "border-border",
                      )}
                    >
                      {state.selectedLocationId === loc.id && (
                        <span className="size-2 rounded-full bg-white" />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[13.5px] font-semibold">{loc.name}</p>
                      <p className="text-[11.5px] text-muted-foreground">
                        {loc.timezone} · {loc.currency}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {!hasSuccessAndLocation && state.testResult.locations.length > 1 && (
            <p className="text-[12px] text-muted-foreground">Select a location to continue.</p>
          )}
        </div>
      )}

      {/* Result: error variants */}
      {state.testState === "error" && state.testError === "token" && (
        <Alert className="border-destructive bg-destructive-soft">
          <CircleAlert className="size-4 text-destructive" />
          <AlertDescription className="text-[13px]">
            <p className="font-semibold text-foreground">Invalid access token</p>
            <p className="mt-0.5 text-muted-foreground">
              Square rejected this token — or it may be for the wrong environment. Double-check you copied the
              full token, with no extra spaces.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={handleClear} className="h-7 text-xs">
                Clear and re-enter
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleSwitchEnv}
                className="h-7 text-xs"
              >
                Switch to {envLabel(otherEnv(state.env))} and retry
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {state.testState === "error" && state.testError === "env" && (
        <Alert className="border-warn bg-warn-soft">
          <TriangleAlert className="size-4 text-warn" />
          <AlertDescription className="text-[13px]">
            <p className="font-semibold text-foreground">Wrong environment</p>
            <p className="mt-0.5 text-muted-foreground">
              This looks like a {envLabel(otherEnv(state.env))} token, but you&apos;re connecting to{" "}
              {envLabel(state.env)}. Switch the environment and test again.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={handleSwitchEnv}
              className="mt-3 h-7 text-xs"
            >
              Switch to {envLabel(otherEnv(state.env))}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {state.testState === "error" && state.testError === "timeout" && (
        <Alert className="border-destructive bg-destructive-soft">
          <WifiOff className="size-4 text-destructive" />
          <AlertDescription className="text-[13px]">
            <p className="font-semibold text-foreground">Couldn&apos;t reach Square</p>
            <p className="mt-0.5 text-muted-foreground">
              The request timed out. Check your internet connection and try again.
            </p>
            <Button variant="outline" size="sm" onClick={handleTest} className="mt-3 h-7 text-xs">
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {state.testState === "error" && state.testError === "no_locations" && (
        <Alert className="border-destructive bg-destructive-soft">
          <Unplug className="size-4 text-destructive" />
          <AlertDescription className="text-[13px]">
            <p className="font-semibold text-foreground">No active locations</p>
            <p className="mt-0.5 text-muted-foreground">
              This Square account has no active locations. Add a location in your Square dashboard, then test again.
            </p>
          </AlertDescription>
        </Alert>
      )}

      {state.testState === "error" && state.testError === "scope" && (
        <Alert className="border-destructive bg-destructive-soft">
          <CircleAlert className="size-4 text-destructive" />
          <AlertDescription className="text-[13px]">
            <p className="font-semibold text-foreground">Insufficient token permissions</p>
            <p className="mt-0.5 text-muted-foreground">
              This token can&apos;t read the merchant profile. Make sure it has{" "}
              <code className="rounded bg-muted px-1 text-[11px]">MERCHANT_PROFILE_READ</code> scope.
            </p>
            <Button variant="outline" size="sm" onClick={handleClear} className="mt-3 h-7 text-xs">
              Clear and re-enter
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {state.testState === "error" && state.testError === "generic" && (
        <Alert className="border-destructive bg-destructive-soft">
          <CircleAlert className="size-4 text-destructive" />
          <AlertDescription className="text-[13px]">
            <p className="font-semibold text-foreground">Square returned an unexpected error</p>
            <p className="mt-0.5 text-muted-foreground">Try again in a moment.</p>
            <Button variant="outline" size="sm" onClick={handleTest} className="mt-3 h-7 text-xs">
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
