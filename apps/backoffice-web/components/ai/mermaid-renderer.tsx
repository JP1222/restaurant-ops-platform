"use client";

import DOMPurify from "dompurify";
import mermaid from "mermaid";
import { useTheme } from "next-themes";
import { useEffect, useId, useRef, useState } from "react";
import type { CustomRendererProps } from "streamdown";

import { cn } from "@/lib/utils";

// Renders an LLM-authored ```mermaid fence to SVG. Streamdown's built-in mermaid
// path needs the @streamdown/mermaid plugin (a devDependency of streamdown, so not
// installed for consumers) — which is why fences showed as raw code. We render
// diagrams ourselves and register this via Streamdown's `plugins.renderers`
// (see ai-elements/response.tsx).
//
// Streaming: Streamdown re-invokes this renderer on every token, and it reports
// `isIncomplete: false` even while the fence is still streaming (it auto-closes
// open fences to render them) — so that flag can't gate rendering. Instead we
// gate on real parseability: mermaid.parse(..., { suppressErrors: true }) returns
// false (quietly, no throw) for partial OR invalid source, and a truthy result
// only once the diagram is complete and valid. We only render() then, so the
// half-arrived fragments that arrive mid-stream are skipped instead of throwing.
//
// Security: the diagram source is untrusted LLM output. mermaid runs under
// securityLevel "strict" (encodes HTML labels, disables click handlers, sanitizes
// its own SVG). We then re-sanitize with DOMPurify and mount the result as a
// sanitized DOM *fragment* via replaceChildren — never innerHTML / dangerouslySetInnerHTML.

type Status = "pending" | "rendered" | "failed";

// How long the source may sit unchanged-and-unparseable before we call it broken
// rather than still-streaming. Each new stream frame re-runs the effect and
// resets this, so a normal stream never trips it; only a settled, invalid
// diagram escalates to the error card.
const SETTLE_MS = 2500;

export function MermaidRenderer({ code }: CustomRendererProps) {
  const { resolvedTheme } = useTheme();
  const reactId = useId();
  const id = `mmd-${reactId.replace(/[^a-zA-Z0-9]/g, "")}`;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<Status>("pending");

  useEffect(() => {
    const src = code.trim();
    if (!src) return; // nothing to render yet; status stays at its "pending" default
    let cancelled = false;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;

    void (async () => {
      const valid = await mermaid.parse(src, { suppressErrors: true }).catch(() => false);
      if (cancelled) return;

      if (!valid) {
        // Partial (mid-stream) or genuinely broken — indistinguishable here.
        // Stay neutral; only surface an error if the code settles still-invalid.
        settleTimer = setTimeout(() => {
          if (!cancelled) setStatus("failed");
        }, SETTLE_MS);
        return;
      }

      try {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: resolvedTheme === "dark" ? "dark" : "neutral",
          // Render labels as native SVG <text>, NOT html-in-<foreignObject>. Our
          // DOMPurify pass (svg-only profile) strips foreignObject — a known SVG
          // XSS vector — which would leave every node an empty shape. Native text
          // survives sanitization AND removes html-in-svg entirely (smaller
          // attack surface). The top-level key is the one that takes effect.
          htmlLabels: false,
          flowchart: { htmlLabels: false },
        });
        const { svg } = await mermaid.render(id, src);
        const fragment = DOMPurify.sanitize(svg, {
          USE_PROFILES: { svg: true, svgFilters: true },
          RETURN_DOM_FRAGMENT: true,
        });
        if (cancelled || !containerRef.current) return;
        containerRef.current.replaceChildren(fragment);
        setStatus("rendered");
      } catch (err) {
        if (cancelled) return;
        // Parsed but failed to render — genuinely broken, not a streaming artifact.
        console.error("[mermaid] diagram render failed:", err);
        containerRef.current?.replaceChildren();
        setStatus("failed");
      }
    })();

    return () => {
      cancelled = true;
      if (settleTimer) clearTimeout(settleTimer);
    };
  }, [code, resolvedTheme, id]);

  if (status === "failed") {
    return (
      <div className="border-destructive/40 bg-destructive/5 my-3 rounded-md border p-3">
        <p className="text-destructive mb-2 text-xs font-medium">Couldn’t render this diagram.</p>
        <pre className="bg-muted text-muted-foreground overflow-auto rounded p-2 text-xs">
          <code>{code}</code>
        </pre>
      </div>
    );
  }

  return (
    <>
      <div
        ref={containerRef}
        className={cn(
          "bg-card my-3 flex justify-center overflow-x-auto rounded-md border p-3 [&_svg]:h-auto [&_svg]:max-w-full",
          status !== "rendered" && "hidden",
        )}
      />
      {status !== "rendered" ? (
        <div className="text-muted-foreground my-3 flex items-center gap-2 rounded-md border border-dashed p-3 text-xs">
          <span className="bg-muted-foreground/50 size-2 animate-pulse rounded-full" />
          Rendering diagram…
        </div>
      ) : null}
    </>
  );
}
