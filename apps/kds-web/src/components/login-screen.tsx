"use client";

import { type FormEvent, useState } from "react";
import { buildPostLoginDestination, type AuthenticatedSession } from "@/lib/auth";
import { authenticateWithPasskey, loginWithPassword } from "@/lib/auth-client";
import { isPasskeyActionDisabled, resolvePasskeyFeedback, usePasskeySupport } from "@rop/auth/client";

type LoginScreenProps = {
  returnTo: string;
};

type FeedbackState = {
  tone: "error" | "info";
  message: string;
} | null;

function navigateAfterLogin(session: AuthenticatedSession, returnTo: string) {
  window.location.assign(buildPostLoginDestination(session, returnTo));
}

export function LoginScreen({ returnTo }: LoginScreenProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [feedback, setFeedback] = useState<FeedbackState>(null);
  const [activeAction, setActiveAction] = useState<"password" | "passkey" | null>(null);
  const passkeySupport = usePasskeySupport();

  async function handlePasswordSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFeedback(null);
    setActiveAction("password");

    try {
      const response = await loginWithPassword(username.trim(), password);
      navigateAfterLogin(response.session, returnTo);
    } catch (nextError) {
      setFeedback({
        tone: "error",
        message: nextError instanceof Error ? nextError.message : "Sign-in failed."
      });
      setActiveAction(null);
    }
  }

  async function handlePasskeySignIn() {
    setFeedback(null);
    setActiveAction("passkey");

    try {
      const response = await authenticateWithPasskey();
      navigateAfterLogin(response.session, returnTo);
    } catch (nextError) {
      const nextFeedback = resolvePasskeyFeedback(nextError, "authentication");
      if (nextFeedback.kind === "feedback") {
        setFeedback({
          tone: nextFeedback.tone,
          message: nextFeedback.message
        });
      }

      setActiveAction(null);
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-panel">
        <p className="eyebrow">Example Kitchen KDS</p>
        <h1>Sign in to the kitchen console</h1>
        <p className="subtle-copy auth-copy">
          Use your admin password or a registered passkey. Password remains available as the fallback path.
        </p>

        {feedback ? <div className={feedback.tone === "error" ? "toast-error" : "toast-info"}>{feedback.message}</div> : null}

        <form className="auth-form" onSubmit={handlePasswordSubmit}>
          <label className="auth-field">
            <span>Username</span>
            <input
              autoComplete="username webauthn"
              disabled={activeAction !== null}
              name="username"
              onChange={(event) => setUsername(event.target.value)}
              placeholder="Kitchen Admin"
              value={username}
            />
          </label>

          <label className="auth-field">
            <span>Password</span>
            <input
              autoComplete="current-password"
              disabled={activeAction !== null}
              name="password"
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Enter your password"
              type="password"
              value={password}
            />
          </label>

          <button className="primary-button auth-submit" disabled={activeAction !== null} type="submit">
            {activeAction === "password" ? "Signing in..." : "Sign in"}
          </button>
        </form>

        <div className="auth-divider">
          <span>or</span>
        </div>

        <button
          className="ghost-button auth-passkey"
          disabled={isPasskeyActionDisabled(passkeySupport, activeAction !== null)}
          onClick={handlePasskeySignIn}
          type="button"
        >
          {activeAction === "passkey"
            ? "Waiting for passkey..."
            : passkeySupport === null
              ? "Checking passkey support..."
              : "Sign in with Passkey"}
        </button>

        <p className="auth-footnote">
          {passkeySupport === null
            ? "Checking whether this browser supports passkeys."
            : passkeySupport
            ? "Passkeys use Face ID, Touch ID, or your hardware security key depending on the device."
            : "This browser does not currently support passkeys."}
        </p>
      </section>
    </main>
  );
}
