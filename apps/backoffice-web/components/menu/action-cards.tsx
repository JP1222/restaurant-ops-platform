"use client";

import type { MenuQuadrant } from "@rop/contracts";
import { Card, CardContent } from "@/components/ui/card";
import { formatRate } from "@/lib/format";
import type { MenuEngineeringView } from "@/lib/menu/kasavana-smith";
import {
  QUADRANT_ACTION,
  QUADRANT_COLOR,
  QUADRANT_LABEL,
  QUADRANT_ORDER
} from "@/lib/menu/quadrant-colors";

// Cell positions in the 2x2 menu-engineering glyph (matches the chart layout:
// margin on the Y axis, popularity on the X axis).
const GLYPH_CELLS: { quadrant: MenuQuadrant; x: number; y: number }[] = [
  { quadrant: "puzzle", x: 0, y: 0 },
  { quadrant: "star", x: 1, y: 0 },
  { quadrant: "dog", x: 0, y: 1 },
  { quadrant: "plowhorse", x: 1, y: 1 }
];

function QuadrantGlyph({ quadrant, size = 26 }: { quadrant: MenuQuadrant; size?: number }) {
  const gap = 1.5;
  const cell = (size - gap) / 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      {GLYPH_CELLS.map((c) => {
        const active = c.quadrant === quadrant;
        return (
          <rect
            key={c.quadrant}
            x={c.x * (cell + gap)}
            y={c.y * (cell + gap)}
            width={cell}
            height={cell}
            rx={2}
            fill={active ? QUADRANT_COLOR[c.quadrant] : "var(--muted)"}
            stroke={active ? QUADRANT_COLOR[c.quadrant] : "var(--border)"}
            strokeWidth={active ? 0 : 1}
          />
        );
      })}
    </svg>
  );
}

export interface ActionCardsProps {
  view: MenuEngineeringView;
}

export function ActionCards({ view }: ActionCardsProps) {
  const contributionByQuadrant = view.items.reduce<Record<MenuQuadrant, number>>(
    (acc, item) => {
      acc[item.quadrant] += item.contribution_cents;
      return acc;
    },
    { star: 0, plowhorse: 0, puzzle: 0, dog: 0 }
  );

  return (
    <div className="grid grid-cols-1 gap-3">
      {QUADRANT_ORDER.map((quadrant) => {
        const count = view.counts[quadrant];
        const share =
          view.totalContributionCents > 0
            ? contributionByQuadrant[quadrant] / view.totalContributionCents
            : 0;
        return (
          <Card key={quadrant} className="transition-colors hover:border-foreground/15">
            <CardContent className="flex gap-3 p-4">
              <QuadrantGlyph quadrant={quadrant} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 font-medium">
                    <span
                      aria-hidden
                      className="inline-block size-2 rounded-full"
                      style={{ background: QUADRANT_COLOR[quadrant] }}
                    />
                    {QUADRANT_LABEL[quadrant]}
                    {count === 1 ? "" : "s"}
                  </span>
                  <span className="text-sm tabular-nums text-muted-foreground">
                    <span className="font-mono font-medium text-foreground">{count}</span>{" "}
                    {count === 1 ? "item" : "items"}
                  </span>
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                  {QUADRANT_ACTION[quadrant]}
                </p>
                <p className="mt-2 text-[11px] tabular-nums text-muted-foreground/80">
                  <span className="font-mono">{formatRate(share, 0)}</span> of contribution $
                </p>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
