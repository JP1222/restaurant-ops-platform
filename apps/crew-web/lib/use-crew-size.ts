"use client";

import { useEffect, useState } from "react";

// Drives the whole crew app's responsive behavior. We treat anything below
// 768px as phone, 768–1180px as tablet (portrait iPad), wider as desktop.
// Orientation lets wide-but-short windows (split-screen) behave like phones.
export type CrewSize = {
  kind: "phone" | "tablet" | "desktop";
  landscape: boolean;
  w: number;
  h: number;
};

function compute(): CrewSize {
  if (typeof window === "undefined") {
    return { kind: "desktop", landscape: true, w: 1200, h: 800 };
  }
  const w = window.innerWidth;
  const h = window.innerHeight;
  const landscape = w >= h;
  let kind: CrewSize["kind"] = "desktop";
  if (w < 768) kind = "phone";
  else if (w < 1180) kind = "tablet";
  return { kind, landscape, w, h };
}

export function useCrewSize(): CrewSize {
  // Always start with the SSR-safe default so server and first client paint
  // agree. The real measurement happens in the effect below.
  const [size, setSize] = useState<CrewSize>(() => ({
    kind: "desktop",
    landscape: true,
    w: 1200,
    h: 800,
  }));

  useEffect(() => {
    const on = () => setSize(compute());
    on();
    window.addEventListener("resize", on);
    window.addEventListener("orientationchange", on);
    return () => {
      window.removeEventListener("resize", on);
      window.removeEventListener("orientationchange", on);
    };
  }, []);

  return size;
}
