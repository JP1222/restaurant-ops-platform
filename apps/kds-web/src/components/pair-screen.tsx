"use client";

import { useEffect, useState } from "react";

import { getApiBaseUrl } from "@/lib/api";
import { writeDeviceMerchantCookie } from "@/lib/device-cookie";

type PairState = "pairing" | "expired" | "nocode";

// Device pairing (ADR-0818 Phase-2b). The device opens the manager's pairing link
// (`/pair?code=…`) once; this redeems the one-time code for the durable device
// token (kds-api sets it as an HttpOnly same-origin cookie), records the bound
// store, then redirects into the store's board/display. No store-id entry, no
// login. After this the device stays paired across reboots — only a manager
// revoke (or a storage wipe) un-pairs it.
export function PairScreen({ code }: { code: string | null }) {
  const [state, setState] = useState<PairState>(code ? "pairing" : "nocode");

  useEffect(() => {
    if (!code) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${getApiBaseUrl()}/api/pair/redeem`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code }),
          cache: "no-store"
        });
        const data = (await res.json().catch(() => null)) as
          | { ok: true; role: "KDS" | "DISPLAY"; merchantId: string }
          | { ok: false }
          | null;
        if (!cancelled && res.ok && data?.ok) {
          writeDeviceMerchantCookie(data.merchantId);
          window.location.assign(data.role === "DISPLAY" ? "/display" : "/board");
          return;
        }
        if (!cancelled) {
          setState("expired");
        }
      } catch {
        if (!cancelled) {
          setState("expired");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code]);

  return (
    <main className="pair-screen">
      {state === "pairing" ? <p className="pair-status">Pairing this device…</p> : null}

      {state === "expired" ? (
        <div className="pair-message">
          <h1>Pairing link expired</h1>
          <p>Ask a manager to generate a fresh pairing link for this device.</p>
        </div>
      ) : null}

      {state === "nocode" ? (
        <div className="pair-message">
          <h1>Pair this device</h1>
          <p>Open the pairing link a manager generated for this store, or scan its QR code.</p>
          <p>
            <a href="/login">Manager sign in</a>
          </p>
        </div>
      ) : null}
    </main>
  );
}
