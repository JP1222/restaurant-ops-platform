"use client";

import { type ReactNode } from "react";
import { Globe } from "lucide-react";
import { z } from "zod";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { isWebSearchTool } from "@/lib/ai/web-tools";

export { isWebSearchTool } from "@/lib/ai/web-tools";

// The `web_search` tool returns external web content — never the operator's own
// store data. This card renders it in MUTED / NEUTRAL tokens (no chart-1 / KPI
// styling) so web sources read as external, not authoritative: web numbers are
// excluded from the numeric guardrail (lib/ai/web-tools.ts), and a bare web-sourced
// figure in the answer still trips the "not verified against tool data" badge.

// Local render-guard schema. Deliberately NOT importing the contracts barrel:
// this is a "use client" component, and importing @rop/contracts pulls the
// whole barrel into the client/SSR bundle of every page that mounts the AI FAB,
// which reorders contracts module-eval and trips a TDZ during prerender. The
// canonical wire schema is WebSearchResultSchema in @rop/contracts (the
// server route validates the tool output with it); this mirror only guards the
// rendered shape — an arbitrary string can't synthesize a valid card.
//
// http(s)-only url: z.string().url() accepts javascript:/data:/vbscript: schemes,
// and source.url becomes an <a href> below (React doesn't block dangerous-scheme
// hrefs). The refinement drops a bad-scheme URL rather than rendering a clickable
// script sink — the same guard WebSearchSourceSchema applies server-side.
const httpUrl = z
  .string()
  .url()
  .refine((value) => {
    try {
      return ["http:", "https:"].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  });
const webSearchSchema = z.object({
  query: z.string(),
  answer: z.string(),
  sources: z.array(z.object({ title: z.string(), url: httpUrl })).max(10),
  available: z.boolean().default(true),
});

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function SourcesCard({ view }: { view: z.infer<typeof webSearchSchema> }) {
  return (
    <Card className="bg-muted/40 w-full border-dashed">
      <CardHeader className="pb-2">
        <CardTitle className="text-muted-foreground flex items-center gap-1.5 text-sm font-medium">
          <Globe className="size-4 shrink-0" aria-hidden />
          From the web
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {view.sources.length > 0 ? (
          <ul className="space-y-1">
            {view.sources.map((source, index) => (
              <li key={index} className="min-w-0">
                <a
                  href={source.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-foreground hover:underline"
                  title={source.url}
                >
                  <span className="text-sm">{source.title}</span>
                  <span className="text-muted-foreground ml-1.5 text-xs">
                    {hostnameOf(source.url)}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-xs">No web sources returned.</p>
        )}
        <p className="text-muted-foreground text-xs">web — not store data</p>
      </CardContent>
    </Card>
  );
}

/**
 * Render a `web_search` tool output as the Sources card, or null when the output
 * doesn't validate or there's nothing to show — the caller (message-bubble) then
 * falls back to the raw tool-output card (same contract as renderToolChart). A
 * graceful `available: false` result (search off / unkeyed) renders nothing here
 * so the model's own "search is unavailable" text carries the message.
 */
export function renderWebSearchCard(toolName: string, output: unknown): ReactNode | null {
  if (!isWebSearchTool(toolName)) return null;
  const parsed = webSearchSchema.safeParse(output);
  if (!parsed.success) return null;
  if (!parsed.data.available) return null;
  if (parsed.data.sources.length === 0) return null;
  return <SourcesCard view={parsed.data} />;
}
