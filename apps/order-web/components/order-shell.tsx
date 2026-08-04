import type { ReactNode } from "react";

/**
 * Each screen now renders its own full-viewport `.yr` container (the Berry
 * redesign), with the cart bar / overlays scoped inside it. So the shell is a
 * thin pass-through — no global floating cart or page-frame chrome needed.
 */
export function OrderShell({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
