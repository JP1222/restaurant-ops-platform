"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { PipelineImagesResponse } from "@/hooks/use-pipeline";
import { RelativeTime } from "./relative-time";

interface Props {
  data: PipelineImagesResponse | undefined;
  isLoading: boolean;
  isError: boolean;
}

export function PipelineImagesCard({ data, isLoading, isError }: Props) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-medium">GHCR images</CardTitle>
        <CardDescription>Latest <span className="font-mono">:main</span> tag per app</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading ? (
          <Skeleton className="h-[160px] w-full" />
        ) : isError || !data ? (
          <p className="text-sm text-muted-foreground">Could not load image versions.</p>
        ) : (
          data.images.map((img) => {
            const main = img.mainTag;
            return (
              <div
                key={img.app}
                className="flex items-center justify-between gap-3 border-b border-card-border pb-2 last:border-0"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{img.app}</p>
                  <p className="truncate font-mono text-[11px] text-muted-foreground">
                    {main ? main.name.slice(0, 24) : img.error ?? "no :main tag"}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  {main ? (
                    <>
                      <p className="text-xs">
                        <RelativeTime iso={main.updatedAt} />
                      </p>
                      <a
                        href={main.htmlUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-[10px] text-muted-foreground hover:text-foreground"
                      >
                        view ↗
                      </a>
                    </>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </div>
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
