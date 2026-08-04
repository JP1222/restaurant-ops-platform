import { useRef } from "react";

// A stable idempotency key for the flow's current submission, owned by its confirm
// state. The key is held in a ref so it survives re-renders, and is reused as long as
// `fingerprint` — a string capturing every field that defines the submission — stays
// the same. So when a cook re-taps "save" after a failed or lost response, the SAME
// key rides along and inventory-api dedups the retry to a no-op (the per-submission
// guard from PR #519). Without this, lib/api.ts minted a fresh UUID per call, so a
// re-tap looked like a brand-new write and could double-apply.
//
// The fingerprint is load-bearing, not cosmetic: inventory-api short-circuits a
// repeated key to the PRIOR stored result, ignoring the new payload. So if the cook
// edits the submission (a different qty, item, reason, …) we MUST mint a fresh key —
// reusing one across an edited payload would silently re-apply the old write and drop
// the edit. New fingerprint → new key; identical fingerprint → same key.
//
// Flows that unmount on success (the FlowSuccess screen → navigate home) get a fresh
// ref on the next entry for free. A confirm state that STAYS mounted after a successful
// write (the catalog quick-action panels here, the backoffice dialogs) must call
// `reset()` on success — otherwise a second, genuinely-separate but identical submission
// (e.g. wasting 2 of the same item twice) would reuse the key and the server would dedup
// the real second write away. Absolute writes (a recount sets on_hand to N) are harmless
// either way; relative writes (waste/receive) are why reset matters.
export function useIdempotencyKey(): {
  keyFor: (fingerprint: string) => string;
  reset: () => void;
} {
  const ref = useRef<{ fingerprint: string; key: string } | null>(null);
  return {
    keyFor(fingerprint: string) {
      if (!ref.current || ref.current.fingerprint !== fingerprint) {
        ref.current = { fingerprint, key: crypto.randomUUID() };
      }
      return ref.current.key;
    },
    reset() {
      ref.current = null;
    }
  };
}
