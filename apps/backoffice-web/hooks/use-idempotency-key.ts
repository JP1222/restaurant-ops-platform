import * as React from "react";

// A stable idempotency key for a single logical mutation, held in a ref so it survives
// re-renders. `keyFor(fingerprint)` returns the same key as long as the fingerprint — a
// string capturing every field that defines the submission — is unchanged, so a re-tap
// after a failed/lost response sends the SAME key and inventory-api dedups the retry to
// a no-op (the per-submission guard from PR #519). Editing the payload changes the
// fingerprint and mints a fresh key: the server short-circuits a repeated key to the
// PRIOR result, so reusing one across an edited payload would silently apply the old
// write and drop the edit.
//
// `reset()` is called from the mutation's onSuccess. Without it, a second, genuinely
// separate but identical submission (e.g. recording the same waste twice) would reuse
// the key and the server would dedup the real second write away. Resetting on success
// means the next submission always starts a fresh key; only the error→retry path reuses.
export function useIdempotencyKey(): {
  keyFor: (fingerprint: string) => string;
  reset: () => void;
} {
  const ref = React.useRef<{ fingerprint: string; key: string } | null>(null);
  return React.useMemo(
    () => ({
      keyFor(fingerprint: string) {
        if (!ref.current || ref.current.fingerprint !== fingerprint) {
          ref.current = { fingerprint, key: crypto.randomUUID() };
        }
        return ref.current.key;
      },
      reset() {
        ref.current = null;
      }
    }),
    []
  );
}
