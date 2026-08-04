import { Image as ImageIcon, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { RelativeTime } from "@/components/ops/relative-time";
import type { PipelineImagesResponse } from "@/hooks/use-pipeline";
import { toneClass } from "./tokens";

function shortDigest(name: string | undefined): string {
  if (!name) return "—";
  return name.replace(/^sha256:/, "").slice(0, 12);
}

export function ImagesCard({
  data,
  isLoading,
  isError,
  drift,
}: {
  data: PipelineImagesResponse | undefined;
  isLoading: boolean;
  isError: boolean;
  drift: readonly string[];
}) {
  const driftSet = new Set(drift);
  const staleCount = (data?.images ?? []).filter((img) => driftSet.has(img.app)).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base font-medium">
          <ImageIcon className="text-muted-foreground size-4" />
          Images
        </CardTitle>
        <CardDescription>Current GHCR :main image per app.</CardDescription>
        {data ? (
          <CardAction>
            <Badge variant="outline" className={staleCount > 0 ? toneClass.amber : toneClass.accent}>
              {staleCount > 0 ? `${staleCount} stale` : "all current"}
            </Badge>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : isError || !data ? (
          <p className="text-muted-foreground text-sm">Could not load image versions.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>App</TableHead>
                  <TableHead>Image · :main</TableHead>
                  <TableHead>Pushed</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.images.map((img) => {
                  const stale = driftSet.has(img.app);
                  return (
                    <TableRow key={img.app}>
                      <TableCell className="font-mono text-xs font-medium">{img.app}</TableCell>
                      <TableCell className="text-muted-foreground font-mono text-[11px]">
                        {img.error ? "—" : shortDigest(img.mainTag?.name)}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                        {img.mainTag ? <RelativeTime iso={img.mainTag.updatedAt} /> : "—"}
                      </TableCell>
                      <TableCell>
                        {stale ? (
                          <Badge variant="outline" className={cn("gap-1 text-[10px]", toneClass.amber)}>
                            <TriangleAlert className="size-3" />
                            changed · redeploy
                          </Badge>
                        ) : (
                          <Badge variant="outline" className={cn("text-[10px]", toneClass.accent)}>
                            up to date
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
