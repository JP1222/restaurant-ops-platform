"use client";

import { useMemo, useState } from "react";
import { type PasskeySummary } from "@/lib/auth";
import { buildBrowserLogoutHref, deletePasskeyCredential, registerPasskey } from "@/lib/auth-client";
import {
  isPasskeyActionDisabled,
  resolvePasskeyFeedback,
  shouldShowPasskeyUnsupported,
  usePasskeySupport
} from "@rop/auth/client";

type SettingsAccessCardProps = {
  displayName: string;
  initialPasskeys: PasskeySummary[];
};

type FeedbackState = {
  tone: "error" | "info" | "success";
  message: string;
} | null;

function formatTimestamp(value: string | null) {
  if (!value) {
    return "Not yet used";
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return value;
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(timestamp);
}

function passkeyLabel(passkey: PasskeySummary, index: number) {
  const transport = passkey.transports[0]?.replaceAll("-", " ") ?? "device";
  return `Passkey ${index + 1} · ${transport}`;
}

function sortPasskeys(passkeys: PasskeySummary[]) {
  return [...passkeys].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

export function SettingsAccessCard({ displayName, initialPasskeys }: SettingsAccessCardProps) {
  const [feedback, setFeedback] = useState<FeedbackState>(null);
  const [passkeys, setPasskeys] = useState(() => sortPasskeys(initialPasskeys));
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [isRegisterPending, setIsRegisterPending] = useState(false);
  const [isLogoutPending, setIsLogoutPending] = useState(false);
  const passkeySupport = usePasskeySupport();
  const passkeyStatusLabel = useMemo(
    () => (passkeys.length > 0 ? `${passkeys.length} active` : "Password only"),
    [passkeys.length]
  );

  function handleRegister() {
    setFeedback(null);
    setIsRegisterPending(true);

    registerPasskey()
      .then(({ passkey }) => {
        setPasskeys((current) => {
          const next = current.filter((entry) => entry.credentialId !== passkey.credentialId);
          next.push(passkey);
          return sortPasskeys(next);
        });
        setFeedback({
          tone: "success",
          message: "Passkey saved. This browser can now reopen the kitchen console with biometrics or a security key."
        });
      })
      .catch((nextError) => {
        const nextFeedback = resolvePasskeyFeedback(nextError, "registration");
        if (nextFeedback.kind === "feedback") {
          setFeedback({
            tone: nextFeedback.tone,
            message: nextFeedback.message
          });
        }
      })
      .finally(() => {
        setIsRegisterPending(false);
      });
  }

  function handleDelete(credentialId: string) {
    setFeedback(null);
    setPendingDelete(credentialId);

    deletePasskeyCredential(credentialId)
      .then(() => {
        setPasskeys((current) => current.filter((entry) => entry.credentialId !== credentialId));
        setFeedback({
          tone: "success",
          message: "Passkey removed."
        });
      })
      .catch((nextError) => {
        setFeedback({
          tone: "error",
          message: nextError instanceof Error ? nextError.message : "Passkey deletion failed."
        });
      })
      .finally(() => {
        setPendingDelete(null);
      });
  }

  function handleLogout() {
    setFeedback(null);
    setIsLogoutPending(true);
    window.location.assign(buildBrowserLogoutHref("/login"));
  }

  return (
    <section className="settings-card">
      <div className="settings-section-head">
        <div>
          <p className="eyebrow">Access</p>
          <h3>Sign-in and session</h3>
        </div>
        <span className="status-pill">{passkeyStatusLabel}</span>
      </div>

      <p className="subtle-copy">
        Manage passkeys for {displayName} and sign out this browser session without leaving the board workflow.
      </p>

      {feedback ? (
        <div
          className={
            feedback.tone === "success"
              ? "toast-success"
              : feedback.tone === "info"
                ? "toast-info"
                : "toast-error"
          }
        >
          {feedback.message}
        </div>
      ) : null}

      <div className="settings-auth-actions">
        <button
          className="primary-button settings-auth-button"
          disabled={isPasskeyActionDisabled(passkeySupport, isRegisterPending || pendingDelete !== null || isLogoutPending)}
          onClick={handleRegister}
          type="button"
        >
          {isRegisterPending ? "Adding passkey..." : passkeySupport === null ? "Checking passkey support..." : "Add passkey"}
        </button>
        <button
          className="ghost-button settings-auth-button"
          disabled={isLogoutPending || isRegisterPending || pendingDelete !== null}
          onClick={handleLogout}
          type="button"
        >
          {isLogoutPending ? "Signing out..." : "Sign out"}
        </button>
      </div>

      {shouldShowPasskeyUnsupported(passkeySupport) ? (
        <div className="toast-warning">This browser does not support passkeys yet. Password sign-in remains available.</div>
      ) : null}

      <div className="settings-passkey-list">
        <div className="settings-section-head">
          <div>
            <p className="eyebrow">Passkeys</p>
            <h3>Registered devices</h3>
          </div>
        </div>

        {passkeys.length === 0 ? (
          <div className="passkey-empty">
            <p className="subtle-copy">No passkeys yet. Add one here to unlock faster sign-in on future visits.</p>
          </div>
        ) : (
          <ul className="passkey-grid">
            {passkeys.map((passkey, index) => (
              <li className="passkey-card" key={passkey.credentialId}>
                <div>
                  <h3>{passkeyLabel(passkey, index)}</h3>
                  <p className="subtle-copy">
                    Added {formatTimestamp(passkey.createdAt)} · Last used {formatTimestamp(passkey.lastUsedAt)}
                  </p>
                  <p className="subtle-copy">
                    {passkey.deviceType === "multiDevice" ? "Synced passkey" : "Device-bound passkey"}
                    {passkey.backedUp ? " · Backed up" : " · Not backed up"}
                  </p>
                </div>

                <div className="passkey-card-actions">
                  <span className="status-pill">{passkey.transports.join(", ") || "internal"}</span>
                  <button
                    className="ghost-button"
                    disabled={pendingDelete !== null || isRegisterPending || isLogoutPending}
                    onClick={() => handleDelete(passkey.credentialId)}
                    type="button"
                  >
                    {pendingDelete === passkey.credentialId ? "Removing..." : "Delete"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
