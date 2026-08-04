"use client";

import { Info } from "lucide-react";
import { formatCents, formatRate } from "@/lib/format";
import type { MenuEngineeringView } from "@/lib/menu/kasavana-smith";

export interface MethodNoteProps {
  view: MenuEngineeringView;
}

/** Spells out how the two split lines were drawn, so the matrix is auditable. */
export function MethodNote({ view }: MethodNoteProps) {
  return (
    <div className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
      <Info className="mt-0.5 size-3.5 shrink-0" />
      <p className="max-w-3xl">
        <span className="font-medium text-foreground">How the quadrants are drawn.</span>{" "}
        Vertical split = popularity threshold of{" "}
        <span className="font-mono">
          (1 / {view.activeCount}) &times; {view.popFactor.toFixed(2)} ={" "}
          {formatRate(view.xThreshold)}
        </span>{" "}
        menu mix. Horizontal split = the units-weighted average contribution margin of{" "}
        <span className="font-mono">{formatCents(view.yThresholdCents)}</span>. Dot size
        encodes units sold.{" "}
        {view.costUnknown.length > 0
          ? `${view.costUnknown.length} ${
              view.costUnknown.length === 1 ? "item" : "items"
            } without a plate cost ${
              view.costUnknown.length === 1 ? "is" : "are"
            } excluded — missing cost is never treated as $0.`
          : "Every item that sold has a plate cost on file."}
      </p>
    </div>
  );
}
