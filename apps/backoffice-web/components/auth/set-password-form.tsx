"use client";

import { useState } from "react";
import { ArrowRight, CheckCircle2, Clock, Loader2 } from "lucide-react";
import { MIN_PASSWORD_LENGTH, type PasswordMutationResponse, type PasswordRejection } from "@rop/contracts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { PasswordField } from "@/components/settings/account/password-field";
import { BreachAlert, PasswordRules, PassphraseTip } from "@/components/settings/account/password-rules";

type SetResult = PasswordMutationResponse | PasswordRejection;

// Public set-password form. Lives outside the (authed) layout, so there is no
// React Query provider here — a plain fetch with local state is intentional.
export function SetPasswordForm({ token }: { token: string }) {
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [breached, setBreached] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  // No token at all → the link is unusable; show the expired state immediately.
  const [expired, setExpired] = useState(token.length === 0);

  const lengthOk = next.length >= MIN_PASSWORD_LENGTH;
  const matchOk = confirm.length > 0 && next === confirm;
  const canSubmit = token.length > 0 && lengthOk && matchOk && !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setBreached(false);
    setSubmitting(true);
    try {
      const response = await fetch("/api/auth/password/set", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, newPassword: next }),
      });
      if (!response.ok) {
        setSubmitting(false);
        return;
      }
      const result = (await response.json()) as SetResult;
      setSubmitting(false);
      if (result.ok) {
        setDone(true);
        window.setTimeout(() => {
          window.location.href = "/login";
        }, 1800);
        return;
      }
      if (result.reason === "token_invalid") {
        setExpired(true);
      } else if (result.reason === "breached") {
        setBreached(true);
      }
    } catch {
      setSubmitting(false);
    }
  };

  if (expired) {
    return (
      <div className="rounded-xl border bg-card p-7 text-center shadow-sm">
        <div className="mx-auto mb-4 grid size-[46px] place-items-center rounded-xl bg-destructive/15 text-destructive">
          <Clock className="size-[23px]" />
        </div>
        <h1 className="text-xl font-semibold tracking-tight">This link has expired</h1>
        <p className="mx-auto mt-2 max-w-[320px] text-sm leading-relaxed text-muted-foreground">
          For your security, set-password links are valid for a limited time and can be used once. Ask an
          owner to send you a new one.
        </p>
        <Alert className="mt-5 text-left">
          <AlertDescription>
            Owners can generate a fresh link from{" "}
            <span className="font-medium text-foreground">Settings → Team &amp; Access</span>.
          </AlertDescription>
        </Alert>
        <Button asChild variant="outline" className="mt-4 w-full">
          <a href="/login">
            <ArrowRight />
            Back to sign in
          </a>
        </Button>
      </div>
    );
  }

  if (done) {
    return (
      <div className="rounded-xl border bg-card p-7 text-center shadow-sm">
        <div className="mx-auto mb-4 grid size-[46px] place-items-center rounded-xl bg-accent-soft text-accent">
          <CheckCircle2 className="size-6" />
        </div>
        <h1 className="text-xl font-semibold tracking-tight">Password set</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          You&apos;re all set. Taking you to sign in…
        </p>
        <div className="mt-4 flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          Redirecting
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border bg-card p-7 shadow-sm">
      <h1 className="text-xl font-semibold tracking-tight">Set your password</h1>
      <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
        Create a password for your Example Kitchen backoffice account.
      </p>

      <div className="mt-5 flex flex-col gap-3.5">
        <PasswordField
          id="sp-new"
          label="New password"
          value={next}
          onChange={(value) => {
            setNext(value);
            if (breached) setBreached(false);
          }}
          placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
          autoComplete="new-password"
          autoFocus
        />
        <PasswordField
          id="sp-confirm"
          label="Confirm password"
          value={confirm}
          onChange={setConfirm}
          placeholder="Re-enter the password"
          autoComplete="new-password"
          invalid={confirm.length > 0 && next !== confirm}
          onEnter={submit}
        />
      </div>

      <div className="mt-4">
        <PasswordRules password={next} confirm={confirm} checking={submitting} breached={breached} />
        <PassphraseTip />
        {breached ? <BreachAlert /> : null}
      </div>

      <Button className="mt-5 w-full" disabled={!canSubmit} onClick={submit}>
        {submitting ? (
          <>
            <Loader2 className="animate-spin" />
            Checking…
          </>
        ) : (
          "Set password"
        )}
      </Button>
    </div>
  );
}
