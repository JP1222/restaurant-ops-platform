"use client";

import { type CSSProperties, useId, useMemo } from "react";

/* ============================================================================
   EXAMPLE KITCHEN — brand visuals (ported from the Claude Design handoff prototype)
   Two-tone wordmark, the stylized roll-cup preview (the builder hero), the
   boba/smoothie cup glyph, the quantity stepper, and confirmation confetti.
   ============================================================================ */

/** Two-tone "example kitchen" wordmark (mint + pink). */
export function Wordmark({
  size = 26,
  className,
  style,
}: {
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span className={`wm${className ? ` ${className}` : ""}`} style={{ fontSize: size, ...style }}>
      <span className="rop">Example</span>
      <span className="rollo">Kitchen</span>
    </span>
  );
}

/* ── The stylized roll-cup preview ───────────────────────────
   A white paper cup (or waffle bowl) with rolled ice-cream swirls in the
   chosen flavor, topping dots scattered on top, and drizzle ribbons.
   The user picked "clean stylized cup illustration that fills" over real-photo
   layering — this is that. */
function rollSpiral(cx: number, cy: number, r: number, color: string) {
  return (
    <g>
      <circle cx={cx} cy={cy} r={r} fill={color} stroke="rgba(42,23,34,.22)" strokeWidth="1" />
      <circle cx={cx} cy={cy} r={r * 0.66} fill="none" stroke="rgba(255,255,255,.5)" strokeWidth="1.4" />
      <circle cx={cx} cy={cy} r={r * 0.34} fill="none" stroke="rgba(255,255,255,.45)" strokeWidth="1.4" />
      <circle cx={cx} cy={cy} r={r * 0.12} fill="rgba(42,23,34,.12)" />
    </g>
  );
}

export type ToppingDot = { key: string; color: string; r?: number };

export function RollCup({
  flavorColor = "#FBEFD2",
  dots = [],
  drizzle = [],
  waffle = false,
  size = 120,
}: {
  flavorColor?: string;
  dots?: ToppingDot[];
  drizzle?: string[];
  waffle?: boolean;
  size?: number;
}) {
  const clipId = useId();
  const spots: [number, number][] = [
    [42, 30], [60, 24], [78, 30], [34, 40], [52, 36], [70, 36], [86, 40],
    [44, 46], [62, 44], [80, 46], [53, 52], [71, 52],
  ];
  const rolls: [number, number][] = [[42, 40], [60, 36], [78, 40], [51, 50], [69, 50]];
  return (
    <svg
      viewBox="0 0 120 130"
      width={size}
      height={(size * 130) / 120}
      role="img"
      aria-label="Live preview of your roll"
    >
      <defs>
        <clipPath id={clipId}>
          <path d="M30 56 L90 56 L84 120 Q84 124 80 124 L40 124 Q36 124 36 120 Z" />
        </clipPath>
      </defs>
      <g style={{ transition: "all .35s ease" }}>
        {rolls.map(([cx, cy], i) => (
          <g key={i}>{rollSpiral(cx, cy, 11, flavorColor)}</g>
        ))}
      </g>
      {drizzle.map((c, i) => (
        <path
          key={`dz${i}`}
          d={`M34 ${34 + i * 5} Q50 ${26 + i * 5} 60 ${36 + i * 5} T86 ${34 + i * 5}`}
          fill="none"
          stroke={c}
          strokeWidth="3.2"
          strokeLinecap="round"
          opacity=".92"
          style={{ transition: "all .3s ease" }}
        />
      ))}
      {dots.map((d, i) => {
        const s = spots[i % spots.length] ?? [0, 0];
        return (
          <circle
            key={d.key}
            cx={s[0]}
            cy={s[1]}
            r={d.r || 4.2}
            fill={d.color}
            stroke="rgba(42,23,34,.3)"
            strokeWidth="1"
            style={{ animation: "pop .3s cubic-bezier(.22,1.4,.4,1)" }}
          />
        );
      })}
      {waffle ? (
        <g>
          <path
            d="M26 58 L94 58 L78 116 Q76 122 70 122 L50 122 Q44 122 42 116 Z"
            fill="#E0A455"
            stroke="var(--ink)"
            strokeWidth="2.5"
          />
          <g clipPath={`url(#${clipId})`} opacity=".5">
            {Array.from({ length: 7 }).map((_, i) => (
              <line key={i} x1={20 + i * 12} y1="50" x2={4 + i * 12} y2="130" stroke="#A86E2E" strokeWidth="2" />
            ))}
            {Array.from({ length: 7 }).map((_, i) => (
              <line key={`b${i}`} x1={100 - i * 12} y1="50" x2={116 - i * 12} y2="130" stroke="#A86E2E" strokeWidth="2" />
            ))}
          </g>
          <path
            d="M26 58 L94 58 L78 116 Q76 122 70 122 L50 122 Q44 122 42 116 Z"
            fill="none"
            stroke="var(--ink)"
            strokeWidth="2.5"
          />
        </g>
      ) : (
        <g>
          <path
            d="M30 56 L90 56 L84 120 Q84 124 80 124 L40 124 Q36 124 36 120 Z"
            fill="#fff"
            stroke="var(--ink)"
            strokeWidth="2.5"
          />
          <rect x="30" y="55" width="60" height="7" rx="3" fill="#fff" stroke="var(--ink)" strokeWidth="2.5" />
        </g>
      )}
    </svg>
  );
}

/** Boba / smoothie cup (preview + tiny menu glyph). */
export function BobaCup({
  color = "#B08458",
  pearls = 0,
  size = 56,
  smoothie = false,
}: {
  color?: string;
  pearls?: number;
  size?: number;
  smoothie?: boolean;
}) {
  const clipId = useId();
  return (
    <svg viewBox="0 0 60 72" width={size} height={(size * 72) / 60} role="img" aria-label="Drink">
      <defs>
        <clipPath id={clipId}>
          <path d="M14 22 L46 22 L41 64 Q41 67 38 67 L22 67 Q19 67 19 64 Z" />
        </clipPath>
      </defs>
      <rect
        x={smoothie ? 38 : 36}
        y="6"
        width="6"
        height="34"
        rx="3"
        transform="rotate(12 41 22)"
        fill={smoothie ? "#9CD9F0" : "#E91E63"}
        stroke="var(--ink)"
        strokeWidth="2"
      />
      <rect x="12" y="16" width="36" height="8" rx="3" fill="#fff" stroke="var(--ink)" strokeWidth="2.2" />
      <path
        d="M14 22 L46 22 L41 64 Q41 67 38 67 L22 67 Q19 67 19 64 Z"
        fill="#fff"
        stroke="var(--ink)"
        strokeWidth="2.4"
      />
      <g clipPath={`url(#${clipId})`}>
        <rect x="12" y={smoothie ? 24 : 28} width="36" height="44" fill={color} opacity={smoothie ? 1 : 0.92} />
        {!smoothie &&
          Array.from({ length: Math.min(pearls ? 7 : 0, 7) }).map((_, i) => (
            <circle key={i} cx={22 + (i % 4) * 5.5} cy={58 - Math.floor(i / 4) * 5} r="2.6" fill="#3A2A22" />
          ))}
        {smoothie &&
          Array.from({ length: pearls ? 7 : 0 })
            .slice(0, 7)
            .map((_, i) => (
              <circle key={i} cx={22 + (i % 4) * 5.5} cy={60 - Math.floor(i / 4) * 5} r="2.6" fill="#3A2A22" />
            ))}
      </g>
      <path
        d="M14 22 L46 22 L41 64 Q41 67 38 67 L22 67 Q19 67 19 64 Z"
        fill="none"
        stroke="var(--ink)"
        strokeWidth="2.4"
      />
    </svg>
  );
}

/** +/- quantity stepper (countable modifier control). */
export function Stepper({
  value,
  onChange,
  min = 0,
  max = 9,
}: {
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
}) {
  return (
    <div className="stepper">
      <button onClick={() => onChange(Math.max(min, value - 1))} disabled={value <= min} aria-label="Decrease" type="button">
        –
      </button>
      <span className="n">{value}</span>
      <button onClick={() => onChange(Math.min(max, value + 1))} disabled={value >= max} aria-label="Increase" type="button">
        +
      </button>
    </div>
  );
}

const CONFETTI_COLORS = ["var(--pink)", "var(--mint)", "var(--lemon)", "var(--orange)", "var(--sky)", "var(--grape)"];

/** Confirmation confetti. Index-seeded (deterministic) so it never trips SSR
 *  hydration; purely decorative (aria-hidden). */
export function Confetti({ n = 22 }: { n?: number }) {
  const bits = useMemo(
    () =>
      Array.from({ length: n }).map((_, i) => ({
        left: `${8 + ((i * 37) % 84)}%`,
        background: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
        animationDelay: `${((i * 13) % 30) / 100}s`,
        rotate: (i * 47) % 360,
      })),
    [n],
  );
  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "hidden" }} aria-hidden="true">
      {bits.map((b, i) => (
        <span
          key={i}
          className="confetti"
          style={{
            left: b.left,
            background: b.background,
            animationDelay: b.animationDelay,
            transform: `rotate(${b.rotate}deg)`,
          }}
        />
      ))}
    </div>
  );
}
