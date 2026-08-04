"use client";

import * as React from "react";

export function useIsMobile(query = "(max-width: 1023px)"): boolean {
  const [match, setMatch] = React.useState(false);

  React.useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    const sync = () => setMatch(mql.matches);
    sync();
    mql.addEventListener?.("change", sync);
    return () => mql.removeEventListener?.("change", sync);
  }, [query]);

  return match;
}
