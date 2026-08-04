"use client";

import { cn } from "@/lib/cn";
import { useCrewData } from "@/lib/crew-data";
import { crewStatus } from "@/lib/crew-status";
import { STRINGS } from "@/lib/strings";
import type { Employee, Lang, Screen } from "@/lib/types";
import { useCrewSize } from "@/lib/use-crew-size";

// Home, regrouped per the design handoff into two labeled sections:
//   MOVIMIENTOS — a full-width violet "Escanear factura" hero, then Recibir /
//                 Merma / Reconteo colored tiles.
//   CATÁLOGO    — one full-width dark "Artículos" tile with live counts.
// The old per-tile Agregar / 86 are gone (Agregar → "＋ Nuevo" in Items; 86 → an
// action inside item detail). The shift/clock card was dropped. Greeting is just
// "Hola, {firstName}".
export function CrewHome({
  employee,
  lang,
  onPick,
  onRefresh,
  refreshing,
}: {
  employee: Employee;
  lang: Lang;
  onPick: (s: Screen) => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const T = STRINGS[lang];
  const phone = useCrewSize().kind === "phone";
  const { items, pos } = useCrewData();

  const critical = items.filter((it) => crewStatus(it) === "critical").length;
  const openPos = pos.filter((p) => p.status === "in-transit").length;

  // glyph is a ReactNode (not just an emoji string): the barcode stock-adjust tile
  // (design handoff §8a) wants a stroked viewfinder SVG, while the others keep their
  // emoji. The tile box renders {glyph} either way.
  const movements: { id: Screen; label: string; sub: string; glyph: React.ReactNode; bg: string; badge?: string }[] = [
    {
      id: "receive",
      label: T.mov_receive,
      sub: T.mov_receive_sub,
      glyph: "📦",
      bg: "#d97706",
      badge: openPos > 0 ? String(openPos) : undefined,
    },
    { id: "waste", label: T.mov_waste, sub: T.mov_waste_sub, glyph: "🗑", bg: "#ef4444" },
    { id: "recount", label: T.mov_recount, sub: T.mov_recount_sub, glyph: "📋", bg: "#2A6FDB" },
    // Barcode stock-adjust (design handoff §8): scan an item → nudge on_hand by a
    // signed amount. Teal #0d9488 (shadow derives as #0d948855 in the tile style).
    {
      id: "scan-barcode",
      label: T.scan_pull_tile,
      sub: T.scan_pull_tile_sub,
      glyph: <ScanViewfinderIcon className={phone ? "size-6" : "size-[34px]"} />,
      bg: "#0d9488",
    },
  ];

  return (
    <div
      className={cn("h-full overflow-y-auto", phone ? "p-4" : "p-10")}
      style={phone ? { paddingBottom: "calc(1rem + env(safe-area-inset-bottom))" } : undefined}
    >
      <div className={cn("flex items-center gap-3", phone ? "mb-4" : "mb-7")}>
        <h1
          className={cn(
            "flex-1 min-w-0 font-semibold tracking-tight text-zinc-900",
            phone ? "text-2xl" : "text-4xl",
          )}
        >
          {T.hi}, {employee.name.split(" ")[0]}
        </h1>
        {/* Manual companion to the home-screen polling (2026-06-12 audit P1):
            a cook who just heard "the delivery is in" shouldn't wait out the
            interval to see the badges move. */}
        <button
          onClick={onRefresh}
          disabled={refreshing}
          aria-label={T.home_refresh}
          title={T.home_refresh}
          className={cn(
            "rounded-xl bg-zinc-100 active:bg-zinc-200 flex items-center justify-center flex-none text-zinc-600",
            phone ? "size-10" : "size-12",
          )}
        >
          <RefreshIcon className={cn(phone ? "size-5" : "size-6", refreshing && "animate-spin")} />
        </button>
      </div>

      <GroupLabel>{T.group_mov}</GroupLabel>

      <button
        onClick={() => onPick("scan")}
        className={cn(
          "relative w-full rounded-3xl text-left text-white flex items-center transition-transform active:scale-[0.98]",
          phone ? "p-4 gap-4" : "px-8 py-7 gap-7",
        )}
        style={{
          background: "linear-gradient(110deg,#6D5AE0 0%,#8B6FE8 55%,#5B8DEF 130%)",
          boxShadow: "0 18px 40px -12px rgba(109,90,224,.5)",
        }}
      >
        <div
          className={cn(
            "rounded-2xl flex items-center justify-center flex-none bg-white/15",
            phone ? "size-12 text-2xl" : "size-[74px] text-4xl",
          )}
        >
          🧾
        </div>
        <div className="flex-1 min-w-0">
          <div className={cn("font-semibold tracking-tight", phone ? "text-lg" : "text-[26px]")}>
            {T.scan_hero}
          </div>
          <div className={cn("text-white/85", phone ? "text-sm" : "text-base mt-0.5")}>
            {T.scan_hero_sub}
          </div>
        </div>
        {!phone && (
          <span
            className="inline-flex items-center gap-2 px-6 rounded-2xl bg-white font-semibold text-base flex-none"
            style={{ color: "#5B4BD0", height: 52 }}
          >
            <CameraIcon className="size-[18px]" />
            {T.scan_hero_cta}
          </span>
        )}
      </button>

      {/* 4-up on iPad (receive / waste / recount / scan-barcode), stacked on phone —
          matches the design handoff §8a Movements row. */}
      <div className={cn("grid gap-3 sm:gap-5", phone ? "mt-3 grid-cols-1" : "mt-5 grid-cols-4")}>
        {movements.map((m) => (
          <button
            key={m.id}
            onClick={() => onPick(m.id)}
            className={cn(
              "relative rounded-3xl text-left text-white flex transition-transform active:scale-[0.98]",
              phone ? "p-4 items-center gap-4" : "p-7 flex-col justify-between min-h-40",
            )}
            style={{ background: m.bg, boxShadow: `0 12px 30px -8px ${m.bg}55` }}
          >
            {m.badge && (
              <span
                className={cn(
                  "rounded-full bg-white/25 font-semibold flex items-center justify-center",
                  phone
                    ? "order-last ml-auto min-w-7 h-7 px-2 text-sm"
                    : "absolute top-5 right-5 min-w-9 h-9 px-2.5 text-base",
                )}
              >
                {m.badge}
              </span>
            )}
            <div
              className={cn(
                "rounded-2xl flex items-center justify-center flex-none bg-white/15",
                phone ? "size-12 text-2xl" : "size-16 text-3xl",
              )}
            >
              {m.glyph}
            </div>
            <div className={cn(phone ? "flex-1 min-w-0" : "")}>
              <div className={cn("font-semibold tracking-tight", phone ? "text-lg" : "text-2xl")}>
                {m.label}
              </div>
              <div className={cn("text-white/85", phone ? "text-sm" : "text-[15px] mt-0.5")}>
                {m.sub}
              </div>
            </div>
          </button>
        ))}
      </div>

      <GroupLabel className={phone ? "mt-5" : "mt-7"}>{T.group_cat}</GroupLabel>

      <button
        onClick={() => onPick("items")}
        className={cn(
          "relative w-full rounded-3xl text-left text-white flex items-center transition-transform active:scale-[0.98]",
          phone ? "p-4 gap-4" : "px-7 py-6 gap-6",
        )}
        style={{ background: "#27272a" }}
      >
        <div
          className={cn(
            "rounded-2xl flex items-center justify-center flex-none bg-white/15",
            phone ? "size-12 text-2xl" : "size-16 text-3xl",
          )}
        >
          📦
        </div>
        <div className="flex-1 min-w-0">
          <div className={cn("font-semibold tracking-tight", phone ? "text-lg" : "text-[22px]")}>
            {T.cat_items}
          </div>
          <div className={cn("text-white/85", phone ? "text-sm" : "text-[15px] mt-0.5")}>
            {T.cat_items_sub}
          </div>
        </div>
        {!phone && (
          <div className="flex gap-2.5 flex-none">
            <span className="rounded-xl bg-white/15 px-3.5 py-2 text-sm">
              <b className="font-bold tabular-nums">{items.length}</b> {T.count_items}
            </span>
            {critical > 0 && (
              <span className="rounded-xl px-3.5 py-2 text-sm" style={{ background: "rgba(220,38,38,.3)" }}>
                <b className="font-bold tabular-nums">{critical}</b> {T.count_critical}
              </span>
            )}
          </div>
        )}
        {phone && <ChevronRightIcon className="size-5 opacity-60 flex-none" />}
      </button>
    </div>
  );
}

function GroupLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "text-[13px] font-semibold tracking-wider uppercase text-zinc-400 mb-3 ml-1",
        className,
      )}
    >
      {children}
    </div>
  );
}

function RefreshIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />
    </svg>
  );
}

function CameraIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
      <circle cx="12" cy="13" r="3" />
    </svg>
  );
}

// Viewfinder / scan glyph for the barcode stock-adjust tile (design handoff §8a):
// four corner brackets + a center scan line. Stroked in currentColor (white on the
// teal tile), matching the camera-stage reticle.
function ScanViewfinderIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" />
      <path d="M7 12h10" />
    </svg>
  );
}

function ChevronRightIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}
