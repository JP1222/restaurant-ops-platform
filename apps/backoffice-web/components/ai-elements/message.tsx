"use client";

// Vendored from Vercel AI Elements (MIT), re-pointed at our shadcn aliases and
// trimmed to Message + MessageContent. The `is-user` / `is-assistant` marker
// classes let MessageContent style itself via group-[] without prop drilling —
// kept verbatim from upstream so the bubble look matches the library.

import type { ComponentProps, HTMLAttributes } from "react";
import type { UIMessage } from "ai";

import { cn } from "@/lib/utils";

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: UIMessage["role"];
};

export function Message({ className, from, ...props }: MessageProps) {
  return (
    <div
      className={cn(
        "group flex w-full items-end gap-2",
        from === "user" ? "is-user justify-end" : "is-assistant justify-start",
        className,
      )}
      {...props}
    />
  );
}

export type MessageContentProps = ComponentProps<"div"> & {
  variant?: "contained" | "flat";
};

export function MessageContent({
  children,
  className,
  variant = "contained",
  ...props
}: MessageContentProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 overflow-hidden text-sm",
        variant === "contained" && [
          "max-w-[85%] rounded-2xl px-4 py-2.5",
          "group-[.is-user]:bg-primary group-[.is-user]:text-primary-foreground group-[.is-user]:rounded-br-md",
          "group-[.is-assistant]:bg-muted/40 group-[.is-assistant]:text-foreground group-[.is-assistant]:border group-[.is-assistant]:rounded-bl-md",
        ],
        variant === "flat" && "max-w-full",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
