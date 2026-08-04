"use client";

import { useState } from "react";
import { Loader2, Lock } from "lucide-react";
import { toast } from "sonner";
import { MIN_PASSWORD_LENGTH } from "@rop/contracts";
import { Button } from "@/components/ui/button";
import { useChangePassword } from "@/hooks/use-change-password";
import { PasswordField } from "./password-field";
import { BreachAlert, PasswordRules, PassphraseTip } from "./password-rules";

export function ChangePasswordCard() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [currentError, setCurrentError] = useState("");
  const [breached, setBreached] = useState(false);
  const changePassword = useChangePassword();
  const submitting = changePassword.isPending;

  const lengthOk = next.length >= MIN_PASSWORD_LENGTH;
  const matchOk = confirm.length > 0 && next === confirm;
  const canSubmit = current.length > 0 && lengthOk && matchOk && !submitting;
  const dirty = current.length > 0 || next.length > 0 || confirm.length > 0;

  const reset = () => {
    setCurrent("");
    setNext("");
    setConfirm("");
    setCurrentError("");
    setBreached(false);
  };

  const submit = async () => {
    if (!canSubmit) return;
    setCurrentError("");
    setBreached(false);
    try {
      const result = await changePassword.mutateAsync({ currentPassword: current, newPassword: next });
      if (result.ok) {
        toast.success("Password updated");
        reset();
        return;
      }
      if (result.reason === "incorrect_current") {
        setCurrentError("That current password is incorrect.");
      } else if (result.reason === "breached") {
        setBreached(true);
      } else {
        toast.error(result.message || "Couldn't update password.");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't update password.");
    }
  };

  return (
    <div className="rounded-xl border bg-card p-6 shadow-sm">
      <div className="mb-4 flex items-center gap-3">
        <div className="grid size-[34px] place-items-center rounded-[9px] bg-accent-soft text-accent">
          <Lock className="size-[17px]" />
        </div>
        <div className="flex-1">
          <div className="text-sm font-semibold">Change password</div>
          <div className="text-xs text-muted-foreground">
            Used to sign in to the backoffice. Passkeys are recommended for everyday access.
          </div>
        </div>
      </div>

      <div className="flex max-w-[420px] flex-col gap-3.5">
        <div>
          <PasswordField
            id="cp-current"
            label="Current password"
            value={current}
            onChange={(value) => {
              setCurrent(value);
              if (currentError) setCurrentError("");
            }}
            placeholder="Enter your current password"
            autoComplete="current-password"
            invalid={!!currentError}
            describedBy={currentError ? "cp-current-err" : undefined}
          />
          {currentError ? (
            <p id="cp-current-err" role="alert" className="mt-1.5 text-xs text-destructive">
              {currentError}
            </p>
          ) : null}
        </div>
        <PasswordField
          id="cp-new"
          label="New password"
          value={next}
          onChange={(value) => {
            setNext(value);
            if (breached) setBreached(false);
          }}
          placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
          autoComplete="new-password"
        />
        <PasswordField
          id="cp-confirm"
          label="Confirm new password"
          value={confirm}
          onChange={setConfirm}
          placeholder="Re-enter the new password"
          autoComplete="new-password"
          invalid={confirm.length > 0 && next !== confirm}
          onEnter={submit}
        />
      </div>

      <div className="mt-4 max-w-[420px]">
        <PasswordRules password={next} confirm={confirm} checking={submitting} breached={breached} />
        <PassphraseTip />
        {breached ? <BreachAlert /> : null}
      </div>

      <div className="mt-5 flex max-w-[420px] items-center gap-3">
        <Button disabled={!canSubmit} onClick={submit}>
          {submitting ? (
            <>
              <Loader2 className="animate-spin" />
              Checking…
            </>
          ) : (
            "Update password"
          )}
        </Button>
        {dirty ? (
          <Button variant="ghost" onClick={reset} disabled={submitting}>
            Cancel
          </Button>
        ) : null}
      </div>
    </div>
  );
}
