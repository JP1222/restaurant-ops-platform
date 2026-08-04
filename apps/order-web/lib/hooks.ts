"use client";

import { useEffect, useState } from "react";

/**
 * Real-viewport desktop switch. Drives the `.yr.m` / `.yr.d` mode class so the
 * mobile and desktop layout branches (mirroring the prototype) render from the
 * same component. SSR renders mobile (false) → no hydration mismatch; the
 * effect upgrades to desktop on the client.
 */
export function useIsDesktop(breakpoint = 1024): boolean {
  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${breakpoint}px)`);
    const update = () => setIsDesktop(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [breakpoint]);
  return isDesktop;
}
