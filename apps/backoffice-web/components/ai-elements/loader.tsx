"use client";

// Vendored from Vercel AI Elements (MIT). A minimal spinning loader used for the
// assistant's "Thinking…" state while status === "submitted".

import { Loader2 } from "lucide-react";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

export type LoaderProps = ComponentProps<"div"> & {
  size?: number;
};

export function Loader({ className, size = 16, ...props }: LoaderProps) {
  return (
    <div
      className={cn("inline-flex items-center justify-center text-muted-foreground", className)}
      {...props}
    >
      <Loader2 className="animate-spin" size={size} />
    </div>
  );
}
