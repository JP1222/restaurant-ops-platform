"use client";

import { useState } from "react";
import { login } from "@/lib/api";
import { cn } from "@/lib/cn";
import { STRINGS } from "@/lib/strings";
import type { Employee, Lang } from "@/lib/types";
import { useCrewSize } from "@/lib/use-crew-size";

// Crew PIN length. Hardened from 4 → 6 digits (1M space) — keep in sync with the
// InventoryPinSchema in @rop/contracts and the backoffice crew admin.
const PIN_LENGTH = 6;
const PIN_DOTS = Array.from({ length: PIN_LENGTH }, (_, i) => i);

export function PinLogin({
  lang,
  setLang,
  onSuccess,
  notice,
}: {
  lang: Lang;
  setLang: (l: Lang) => void;
  onSuccess: (e: Employee) => void;
  // Shown in place of the hint when the cook was bounced here (e.g. session expiry).
  notice?: string | null;
}) {
  const T = STRINGS[lang];
  const size = useCrewSize();
  const phone = size.kind === "phone";
  const [pin, setPin] = useState("");
  const [wrong, setWrong] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (full: string) => {
    setBusy(true);
    const result = await login(full);
    setBusy(false);
    if (result.ok) {
      onSuccess(result.employee);
      return;
    }
    const slow = result.reason === "locked" || result.reason === "blocked";
    setWrong(true);
    setErrMsg(
      result.reason === "locked"
        ? T.pin_locked
        : result.reason === "blocked"
          ? T.pin_blocked
          : T.pin_wrong,
    );
    setTimeout(
      () => {
        setPin("");
        setWrong(false);
        setErrMsg(null);
      },
      slow ? 1500 : 600
    );
  };

  const press = (d: string) => {
    if (busy) return;
    setWrong(false);
    setPin((p) => {
      if (p.length >= PIN_LENGTH) return p;
      const np = p + d;
      if (np.length === PIN_LENGTH) setTimeout(() => submit(np), 100);
      return np;
    });
  };
  const back = () => setPin((p) => p.slice(0, -1));
  const clear = () => setPin("");

  if (phone) {
    return (
      <div
        className="h-full w-full flex flex-col"
        style={{ background: "#fdf9f3" }}
      >
        <div
          className="px-6 pb-5 text-center"
          style={{
            // Extend the green under the notch and push the wordmark clear of it.
            paddingTop: "calc(2rem + env(safe-area-inset-top))",
            background: "linear-gradient(160deg, #1F8A5B 0%, #186e49 100%)",
          }}
        >
          <div className="flex items-center justify-center gap-2 text-white">
            <span style={{ fontSize: 36 }}>🍙</span>
            <div className="text-left">
              <div className="text-white/70 text-[10px] font-medium tracking-widest uppercase">
                Example Kitchen
              </div>
              <div className="text-white text-xl font-semibold tracking-tight leading-tight">
                Crew
              </div>
            </div>
          </div>
          <div className="mt-2 text-white/85 text-sm">{T.storeName}</div>
        </div>

        <div
          className="flex-1 flex flex-col items-center justify-center px-6 pb-6"
          style={{
            paddingBottom: "calc(1.5rem + env(safe-area-inset-bottom))",
          }}
        >
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 text-center">
            {T.pin_title}
          </h1>
          <p
            className={cn(
              "text-center mt-1 text-sm",
              notice ? "text-amber-600 font-medium" : "text-zinc-500",
            )}
          >
            {notice ?? T.pin_hint}
          </p>

          <div className="mt-6 flex items-center justify-center gap-2.5">
            {PIN_DOTS.map((i) => (
              <div
                key={i}
                className={cn(
                  "size-4 rounded-full transition-all duration-150",
                  wrong
                    ? "bg-red-500 animate-pulse"
                    : pin.length > i
                      ? "bg-zinc-900"
                      : "bg-zinc-200",
                )}
              />
            ))}
          </div>
          {wrong && (
            <p className="text-center text-red-500 text-sm mt-2 font-medium">
              {errMsg ?? T.pin_wrong}
            </p>
          )}

          <div className="w-full max-w-[320px] mt-6 grid grid-cols-3 gap-2.5">
            {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => (
              <button
                key={d}
                onClick={() => press(String(d))}
                className="h-16 rounded-2xl bg-white border border-zinc-200 text-2xl font-medium text-zinc-900 active:bg-zinc-100 active:scale-95 transition-transform shadow-sm"
              >
                {d}
              </button>
            ))}
            <button
              onClick={clear}
              className="h-16 rounded-2xl bg-transparent text-zinc-500 text-sm font-medium hover:bg-zinc-100"
            >
              {T.pin_clear}
            </button>
            <button
              onClick={() => press("0")}
              className="h-16 rounded-2xl bg-white border border-zinc-200 text-2xl font-medium text-zinc-900 active:bg-zinc-100 active:scale-95 transition-transform shadow-sm"
            >
              0
            </button>
            <button
              onClick={back}
              className="h-16 rounded-2xl bg-transparent text-zinc-700 flex items-center justify-center hover:bg-zinc-100"
            >
              <BackspaceIcon size={24} />
            </button>
          </div>

          <div className="mt-5 flex items-center justify-center gap-1 bg-zinc-100 p-1 rounded-full">
            {(["es", "en"] as const).map((L) => (
              <button
                key={L}
                onClick={() => setLang(L)}
                className={cn(
                  "px-4 h-8 rounded-full text-sm font-medium transition-colors",
                  lang === L
                    ? "bg-white shadow-sm text-zinc-900"
                    : "text-zinc-500",
                )}
              >
                {L === "es" ? "Español" : "English"}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Tablet / desktop — two-column.
  return (
    <div className="h-full w-full flex items-stretch">
      <div
        className="w-[42%] flex flex-col items-center justify-center p-12"
        style={{
          background: "linear-gradient(160deg, #1F8A5B 0%, #186e49 100%)",
        }}
      >
        <div className="flex items-center gap-3 text-white">
          <span style={{ fontSize: 64 }}>🍙</span>
          <div>
            <div className="text-white/70 text-sm font-medium tracking-widest uppercase">
              Example Kitchen
            </div>
            <div className="text-white text-3xl font-semibold tracking-tight">
              Crew
            </div>
          </div>
        </div>
        <div className="mt-10 text-white/85 text-base font-medium text-center max-w-xs">
          {T.storeName}
        </div>

      </div>

      <div className="flex-1 flex flex-col items-center justify-center p-10">
        <div className="w-full max-w-[420px]">
          <h1 className="text-3xl font-semibold tracking-tight text-zinc-900 text-center">
            {T.pin_title}
          </h1>
          <p
            className={cn(
              "text-center mt-2",
              notice ? "text-amber-600 font-medium" : "text-zinc-500",
            )}
          >
            {notice ?? T.pin_hint}
          </p>

          <div className="mt-8 flex items-center justify-center gap-3">
            {PIN_DOTS.map((i) => (
              <div
                key={i}
                className={cn(
                  "size-5 rounded-full transition-all duration-150",
                  wrong
                    ? "bg-red-500 animate-pulse"
                    : pin.length > i
                      ? "bg-zinc-900"
                      : "bg-zinc-200",
                )}
              />
            ))}
          </div>
          {wrong && (
            <p className="text-center text-red-500 text-sm mt-3 font-medium">
              {errMsg ?? T.pin_wrong}
            </p>
          )}

          <div className="mt-8 grid grid-cols-3 gap-3">
            {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => (
              <button
                key={d}
                onClick={() => press(String(d))}
                className="h-20 rounded-2xl bg-white border border-zinc-200 text-3xl font-medium text-zinc-900 active:bg-zinc-100 active:scale-95 transition-transform shadow-sm"
              >
                {d}
              </button>
            ))}
            <button
              onClick={clear}
              className="h-20 rounded-2xl bg-transparent text-zinc-500 text-base font-medium hover:bg-zinc-100"
            >
              {T.pin_clear}
            </button>
            <button
              onClick={() => press("0")}
              className="h-20 rounded-2xl bg-white border border-zinc-200 text-3xl font-medium text-zinc-900 active:bg-zinc-100 active:scale-95 transition-transform shadow-sm"
            >
              0
            </button>
            <button
              onClick={back}
              className="h-20 rounded-2xl bg-transparent text-zinc-700 flex items-center justify-center hover:bg-zinc-100"
            >
              <BackspaceIcon size={28} />
            </button>
          </div>

          <div className="mt-8 flex items-center justify-center gap-1 bg-zinc-100 p-1 rounded-full mx-auto w-fit">
            {(["es", "en"] as const).map((L) => (
              <button
                key={L}
                onClick={() => setLang(L)}
                className={cn(
                  "px-5 h-9 rounded-full text-sm font-medium transition-colors",
                  lang === L
                    ? "bg-white shadow-sm text-zinc-900"
                    : "text-zinc-500",
                )}
              >
                {L === "es" ? "Español" : "English"}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function BackspaceIcon({ size = 24 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <path d="M21 5h-9.5l-7 7 7 7H21z" />
      <line x1="18" y1="9" x2="13" y2="14" />
      <line x1="13" y1="9" x2="18" y2="14" />
    </svg>
  );
}
