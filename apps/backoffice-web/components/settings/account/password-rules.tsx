"use client";

import { AlertTriangle, Check, Info, Loader2, X } from "lucide-react";
import { MIN_PASSWORD_LENGTH } from "@rop/contracts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/utils";

type RuleStatus = "pending" | "pass" | "fail" | "checking";

function RuleRow({ status, label }: { status: RuleStatus; label: string }) {
  return (
    <li
      className={cn(
        "flex items-center gap-2.5 text-[12.5px] leading-tight text-muted-foreground",
        status === "pass" && "text-foreground",
        status === "fail" && "text-destructive",
      )}
    >
      <span
        className={cn(
          "grid size-[18px] shrink-0 place-items-center rounded-full",
          status === "pass" && "bg-accent-soft text-accent",
          status === "fail" && "bg-destructive/15 text-destructive",
          (status === "pending" || status === "checking") && "bg-secondary text-muted-foreground",
        )}
      >
        {status === "pass" ? (
          <Check className="size-3" strokeWidth={2.5} />
        ) : status === "fail" ? (
          <X className="size-3" strokeWidth={2.5} />
        ) : status === "checking" ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <span className="size-1.5 rounded-full bg-current opacity-50" />
        )}
      </span>
      <span>{label}</span>
    </li>
  );
}

// The three standard password rules (ADR-0029 P2): length, breach screen,
// match. Length + match are evaluated live client-side; the breach result is
// server-side, surfaced via `checking` (submitting) and `breached`.
export function PasswordRules({
  password,
  confirm,
  checking,
  breached,
}: {
  password: string;
  confirm: string;
  checking: boolean;
  breached: boolean;
}) {
  const lengthOk = password.length >= MIN_PASSWORD_LENGTH;
  const lengthStatus: RuleStatus = password.length === 0 ? "pending" : lengthOk ? "pass" : "fail";
  const matchStatus: RuleStatus = confirm.length === 0 ? "pending" : password === confirm ? "pass" : "fail";
  const breachStatus: RuleStatus = checking ? "checking" : breached ? "fail" : "pending";

  return (
    <ul className="flex flex-col gap-2.5" aria-live="polite">
      <RuleRow
        status={lengthStatus}
        label={
          lengthOk
            ? `At least ${MIN_PASSWORD_LENGTH} characters`
            : `At least ${MIN_PASSWORD_LENGTH} characters${password.length ? ` (${password.length}/${MIN_PASSWORD_LENGTH})` : ""}`
        }
      />
      <RuleRow
        status={breachStatus}
        label={
          checking
            ? "Checking against known breaches…"
            : breached
              ? "Found in a known breach — choose another"
              : "Not a known breached password"
        }
      />
      <RuleRow status={matchStatus} label="Both passwords match" />
    </ul>
  );
}

export function PassphraseTip() {
  return (
    <div className="mt-3.5 flex items-start gap-2.5 text-xs leading-relaxed text-muted-foreground">
      <Info className="mt-0.5 size-3.5 shrink-0" />
      <span>
        Tip: a passphrase of four or more unrelated words — like{" "}
        <span className="font-mono text-[11.5px]">copper-violet-harbor-09</span> — is easier to remember
        and harder to crack than a short, complex password.
      </span>
    </div>
  );
}

export function BreachAlert() {
  return (
    <Alert variant="destructive" className="mt-3.5">
      <AlertTriangle className="size-4" />
      <AlertDescription>
        This password appears in a known data breach. Pick something you haven&apos;t used elsewhere.
      </AlertDescription>
    </Alert>
  );
}
