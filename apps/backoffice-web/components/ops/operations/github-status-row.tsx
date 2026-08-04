import { KeyRound, ShieldCheck, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { toneClass } from "./tokens";

const REPO_SLUG = "example-org/restaurant-ops-platform";

// GitHub connection / token-scope row. The token lives server-side in env and
// is never sent to the browser; this row only reflects whether it's wired and
// what scopes the panel needs.
export function GithubStatusRow({ connected }: { connected: boolean }) {
  return (
    <Card className="py-3">
      <CardContent className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4">
        {connected ? (
          <Badge variant="outline" className={cn("gap-1", toneClass.accent)}>
            <ShieldCheck className="size-3" />
            GitHub connected
          </Badge>
        ) : (
          <Badge variant="outline" className={cn("gap-1", toneClass.amber)}>
            <TriangleAlert className="size-3" />
            GitHub not configured
          </Badge>
        )}
        <span className="text-muted-foreground inline-flex flex-wrap items-center gap-1.5 text-[0.8rem]">
          <KeyRound className="size-3.5 shrink-0" />
          Fine-grained token ·
          <code className="bg-muted rounded px-1 font-mono text-xs">actions:write</code>
          <code className="bg-muted rounded px-1 font-mono text-xs">administration:read</code>
        </span>
        <span className="text-muted-foreground text-xs opacity-80">
          {connected
            ? "configured via backoffice env · never sent to the browser"
            : "set GITHUB_PIPELINE_TOKEN in the backoffice env"}
        </span>
        <span className="text-muted-foreground bg-muted ml-auto rounded-full px-2 py-0.5 font-mono text-xs">
          {REPO_SLUG}
        </span>
      </CardContent>
    </Card>
  );
}
