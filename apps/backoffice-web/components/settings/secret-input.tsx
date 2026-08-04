"use client";

import { CopyIcon, EyeIcon, EyeOffIcon, RotateCwIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const MASK = "●●●●●●●●";
const REVEAL_TIMEOUT_MS = 30_000;

export interface SecretInputProps {
  settingKey: string;
  valuePresent: boolean;
  onRotate: (newValue: string) => Promise<void> | void;
  id?: string;
  disabled?: boolean;
  /**
   * Last 4 chars of the stored value (from the list endpoint's `maskedTail`).
   * When present, the masked field shows `••••••••4f2a` instead of a bare mask,
   * giving the BYOK rows a real "this is the key on file" cue. Never the full value.
   */
  maskedTail?: string | null;
}

/**
 * Masked input for category=secret AppSetting rows. The plaintext value only
 * enters React state during a 30s reveal window; Copy writes to clipboard
 * without ever assigning to state so DOM-inspector / React DevTools never see
 * the cleartext. Rotate uses an uncontrolled ref input that gets wiped on
 * submit so the new value does not linger in memory after the PUT.
 */
export function SecretInput({
  settingKey,
  valuePresent,
  onRotate,
  id,
  disabled = false,
  maskedTail,
}: SecretInputProps) {
  const [revealed, setRevealed] = useState<string | null>(null);
  const [busy, setBusy] = useState<"reveal" | "copy" | "rotate" | null>(null);
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [rotateOpen, setRotateOpen] = useState(false);
  const rotateInputRef = useRef<HTMLInputElement | null>(null);
  const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (revealTimer.current) {
      clearTimeout(revealTimer.current);
      revealTimer.current = null;
    }
  }, []);

  useEffect(() => () => {
    clearTimer();
    setRevealed(null);
  }, [clearTimer]);

  const fetchPlaintext = useCallback(async (): Promise<string | null> => {
    const res = await fetch(`/api/settings/${encodeURIComponent(settingKey)}`, {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      throw new Error(body.message ?? `reveal_failed_${res.status}`);
    }
    return ((await res.json()) as { value: string | null }).value;
  }, [settingKey]);

  const toggleReveal = useCallback(async () => {
    if (revealed !== null) {
      clearTimer();
      setRevealed(null);
      return;
    }
    setBusy("reveal");
    setError(null);
    try {
      const v = await fetchPlaintext();
      setRevealed(v ?? "");
      revealTimer.current = setTimeout(() => {
        setRevealed(null);
        revealTimer.current = null;
      }, REVEAL_TIMEOUT_MS);
    } catch (e) {
      setError(e instanceof Error ? e.message : "reveal_failed");
    } finally {
      setBusy(null);
    }
  }, [revealed, fetchPlaintext, clearTimer]);

  const handleCopy = useCallback(async () => {
    setBusy("copy");
    setError(null);
    try {
      const v = await fetchPlaintext();
      if (!v || !navigator.clipboard) throw new Error("No value to copy");
      await navigator.clipboard.writeText(v);
      setStatus(`${settingKey} copied to clipboard`);
      setTimeout(() => setStatus(""), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "copy_failed");
    } finally {
      setBusy(null);
    }
  }, [fetchPlaintext, settingKey]);

  const submitRotate = useCallback(async () => {
    const next = rotateInputRef.current?.value?.trim() ?? "";
    if (!next) return;
    setBusy("rotate");
    setError(null);
    try {
      await onRotate(next);
      if (rotateInputRef.current) rotateInputRef.current.value = "";
      setRotateOpen(false);
      clearTimer();
      setRevealed(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "rotate_failed");
    } finally {
      setBusy(null);
    }
  }, [onRotate, clearTimer]);

  const inputId = id ?? `secret-${settingKey}`;
  const isRevealed = revealed !== null;
  // When a stored value exists, show its last-4 tail behind the mask so the row
  // reads as a real connection; otherwise a bare mask. Never holds the full value.
  const maskedDisplay = valuePresent && maskedTail ? `${MASK}${maskedTail}` : MASK;
  const RevealIcon = isRevealed ? EyeOffIcon : EyeIcon;
  const revealLabel = isRevealed ? "Hide" : "Reveal";
  const lockedOut = disabled || busy !== null;
  const lockedWithoutValue = lockedOut || !valuePresent;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1">
        <Input
          id={inputId}
          type="text"
          value={revealed ?? maskedDisplay}
          readOnly
          aria-label={`${settingKey} value (masked)`}
          aria-describedby={`${inputId}-status`}
          className="tabular-nums font-mono"
          autoComplete="off"
          spellCheck={false}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={toggleReveal}
          disabled={lockedWithoutValue}
          aria-label={`${revealLabel} ${settingKey}`}
          title={revealLabel}
        >
          <RevealIcon />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={handleCopy}
          disabled={lockedWithoutValue}
          aria-label={`Copy ${settingKey} to clipboard`}
          title="Copy"
        >
          <CopyIcon />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => setRotateOpen(true)}
          disabled={lockedOut}
          aria-label={`Rotate ${settingKey}`}
          title="Rotate"
        >
          <RotateCwIcon />
        </Button>
      </div>
      <div
        id={`${inputId}-status`}
        aria-live="polite"
        aria-atomic="true"
        className="text-muted-foreground min-h-[1rem] text-xs"
      >
        {error ? <span className="text-destructive">{error}</span> : status
          ? status
          : !valuePresent
            ? "No value set — use Rotate to add one."
            : isRevealed
              ? "Re-masking automatically in 30 seconds."
              : null}
      </div>

      <Dialog open={rotateOpen} onOpenChange={setRotateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rotate {settingKey}</DialogTitle>
            <DialogDescription>
              Enter a new value. The previous value is overwritten and not shown. This action is
              logged.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor={`${inputId}-rotate`}>New value</Label>
            <Input
              id={`${inputId}-rotate`}
              ref={rotateInputRef}
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              aria-label={`New value for ${settingKey}`}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRotateOpen(false)} disabled={busy === "rotate"}>
              Cancel
            </Button>
            <Button onClick={submitRotate} disabled={busy === "rotate"} aria-label={`Confirm rotation of ${settingKey}`}>
              {busy === "rotate" ? "Saving…" : "Confirm rotate"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
