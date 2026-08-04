"use client";

import { useState } from "react";
import { Check, Clock, Copy, Lock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Read-only one-time setup link with a copy control + expiry/single-use badges
// (ADR-0029 P2). Shown after Add member / Reset password — no password is ever
// displayed; the operator hands this link to the user.
export function LinkShareBlock({ url, expiresInSeconds }: { url: string; expiresInSeconds: number }) {
  const [copied, setCopied] = useState(false);
  const minutes = Math.max(1, Math.round(expiresInSeconds / 60));

  const copy = async () => {
    try {
      await navigator.clipboard?.writeText(url);
    } catch {
      // Clipboard may be unavailable (insecure context); the field stays selectable.
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="space-y-1.5">
      <Label className="text-[12.5px] font-medium">One-time set-password link</Label>
      <div className="flex gap-2">
        <Input
          readOnly
          value={url}
          aria-label="One-time set-password link"
          onFocus={(event) => event.currentTarget.select()}
          className="font-mono text-xs text-muted-foreground"
        />
        <Button type="button" variant={copied ? "default" : "outline"} onClick={copy} className="shrink-0">
          {copied ? <Check /> : <Copy />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <div className="flex flex-wrap gap-2 pt-1.5">
        <Badge variant="outline">
          <Clock />
          Expires in {minutes} minutes
        </Badge>
        <Badge variant="outline">
          <Lock />
          Single use
        </Badge>
      </div>
    </div>
  );
}
