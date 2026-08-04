"use client";

import { type FormEvent, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  authenticateWithPasskey,
  isPasskeyActionDisabled,
  loginWithPassword,
  resolvePasskeyFeedback,
  usePasskeySupport
} from "@rop/auth/client";
import { GalleryVerticalEndIcon, KeyRoundIcon, Loader2Icon, LockKeyholeIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSeparator
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";

type LoginFormProps = React.ComponentProps<"div"> & {
  returnTo: string;
};

type FeedbackState = {
  tone: "error" | "info";
  message: string;
} | null;

export function LoginForm({ className, returnTo, ...props }: LoginFormProps) {
  const router = useRouter();
  const passkeySupport = usePasskeySupport();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [feedback, setFeedback] = useState<FeedbackState>(null);
  const [activeAction, setActiveAction] = useState<"passkey" | "password" | null>(null);
  const [isPending, startTransition] = useTransition();
  const isBusy = isPending || activeAction !== null;
  const passkeyDisabled = isPasskeyActionDisabled(passkeySupport, isBusy);

  function finishLogin() {
    router.replace(returnTo);
    router.refresh();
  }

  async function handlePasskeyLogin() {
    setFeedback(null);
    setActiveAction("passkey");

    try {
      await authenticateWithPasskey({
        optionsPath: "/api/auth/login/passkey/options",
        verifyPath: "/api/auth/login/passkey/verify"
      });
      startTransition(finishLogin);
    } catch (error) {
      const nextFeedback = resolvePasskeyFeedback(error, "authentication");
      setFeedback(
        nextFeedback.kind === "feedback"
          ? {
              tone: nextFeedback.tone,
              message: nextFeedback.message
            }
          : null
      );
    } finally {
      setActiveAction(null);
    }
  }

  async function handlePasswordLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFeedback(null);
    setActiveAction("password");

    try {
      await loginWithPassword(username.trim(), password);
      startTransition(finishLogin);
    } catch (error) {
      setFeedback({
        tone: "error",
        message: error instanceof Error ? error.message : "Sign-in failed."
      });
    } finally {
      setActiveAction(null);
    }
  }

  return (
    <div className={cn("flex w-full max-w-md flex-col gap-6", className)} {...props}>
      <div className="flex items-center gap-2 self-center font-medium">
        <div className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <GalleryVerticalEndIcon className="size-4" />
        </div>
        Example Kitchen Backoffice
      </div>

      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-xl">
            <h1>Sign in to Backoffice</h1>
          </CardTitle>
          <CardDescription>Use your KDS admin passkey or password.</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field>
              <Button
                type="button"
                className="w-full"
                disabled={passkeyDisabled}
                onClick={handlePasskeyLogin}
              >
                {activeAction === "passkey" ? (
                  <Loader2Icon className="size-4 animate-spin" />
                ) : (
                  <KeyRoundIcon className="size-4" />
                )}
                Sign in with passkey
              </Button>
              {passkeySupport === false ? (
                <FieldDescription className="text-center text-destructive">
                  Passkeys are not available in this browser. Use password instead.
                </FieldDescription>
              ) : null}
            </Field>

            <FieldSeparator className="*:data-[slot=field-separator-content]:bg-card">
              Or use password
            </FieldSeparator>

            <form onSubmit={handlePasswordLogin}>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="username">Username</FieldLabel>
                  <Input
                    id="username"
                    autoComplete="username"
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    required
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="password">Password</FieldLabel>
                  <Input
                    id="password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    required
                  />
                </Field>
                {feedback ? (
                  <FieldDescription
                    role="alert"
                    className={feedback.tone === "error" ? "text-destructive" : "text-muted-foreground"}
                  >
                    {feedback.message}
                  </FieldDescription>
                ) : null}
                <Field>
                  <Button type="submit" variant="secondary" disabled={isBusy} className="w-full">
                    {activeAction === "password" ? (
                      <Loader2Icon className="size-4 animate-spin" />
                    ) : (
                      <LockKeyholeIcon className="size-4" />
                    )}
                    Sign in with password
                  </Button>
                </Field>
              </FieldGroup>
            </form>
          </FieldGroup>
        </CardContent>
      </Card>

      <FieldDescription className="px-6 text-center">
        Access is limited to existing KDS admin accounts.
      </FieldDescription>
    </div>
  );
}
