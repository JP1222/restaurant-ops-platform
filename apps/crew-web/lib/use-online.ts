"use client";

import { useEffect, useState } from "react";

// Real browser connectivity for the offline indicator (design handoff §7). Unlike
// the prototype's tap-to-toggle demo chip, this reflects actual reachability via
// `navigator.onLine` + the `online` / `offline` window events.
//
// Scope note: this is the *indicator* only. A durable offline write-queue with
// replay (the prototype's "queued / synced N changes") is deliberately deferred —
// it would have to wrap every write path with persistent storage + a service
// worker, which the app's lean philosophy pushes back on. Today an offline write
// still surfaces the existing `offline` WriteFailure ("no connection — try again"),
// so the banner copy promises browsing, not auto-sync (see `net_offline_banner`).
//
// `navigator.onLine` is a coarse signal — it reports the OS link state, not true
// internet reachability — but it's the right primitive for a "you're offline"
// affordance and costs nothing. The SSR-safe default (online) matches the server
// render, then the effect syncs the real value, mirroring `useCrewSize`.
export function useOnline(): boolean {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    const sync = () => setOnline(navigator.onLine);
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);

  return online;
}
