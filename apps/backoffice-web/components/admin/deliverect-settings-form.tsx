"use client";

import { useState } from "react";
import type {
  DeliverectIntegrationConfig,
  DeliverectIntegrationUpdateRequest
} from "@rop/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { useUpdateDeliverectIntegration } from "@/hooks/use-admin-deliverect-integration";

interface DeliverectSettingsFormProps {
  initial: DeliverectIntegrationConfig | null;
}

interface DraftState {
  enabled: boolean;
  environment: "staging" | "production";
  externalLocationId: string;
  providerLocationId: string;
  channelLinkId: string;
  apiToken: string;
  hmacSecret: string;
}

function blankDraft(initial: DeliverectIntegrationConfig | null): DraftState {
  return {
    enabled: initial?.enabled ?? false,
    environment: initial?.environment ?? "staging",
    externalLocationId: initial?.externalLocationId ?? "",
    providerLocationId: initial?.providerLocationId ?? "",
    channelLinkId: initial?.channelLinkId ?? "",
    apiToken: "",
    hmacSecret: ""
  };
}

export function DeliverectSettingsForm({ initial }: DeliverectSettingsFormProps) {
  const update = useUpdateDeliverectIntegration();
  const [draft, setDraft] = useState<DraftState>(() => blankDraft(initial));
  const [lastSeenInitial, setLastSeenInitial] =
    useState<DeliverectIntegrationConfig | null>(initial);
  const [showApiToken, setShowApiToken] = useState(false);
  const [showHmacSecret, setShowHmacSecret] = useState(false);
  const [savedTick, setSavedTick] = useState(0);

  if (lastSeenInitial !== initial) {
    setLastSeenInitial(initial);
    setDraft(blankDraft(initial));
  }

  function patch(updater: (prev: DraftState) => DraftState) {
    setDraft((prev) => updater(prev));
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body: DeliverectIntegrationUpdateRequest = {
      enabled: draft.enabled,
      environment: draft.environment,
      externalLocationId: draft.externalLocationId,
      providerLocationId: draft.providerLocationId,
      channelLinkId: draft.channelLinkId,
      ...(draft.apiToken ? { apiToken: draft.apiToken } : {}),
      ...(draft.hmacSecret ? { hmacSecret: draft.hmacSecret } : {})
    };
    await update.mutateAsync(body);
    setSavedTick((n) => n + 1);
    patch((prev) => ({ ...prev, apiToken: "", hmacSecret: "" }));
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-medium">Deliverect</CardTitle>
        <CardDescription>
          Provider credentials and channel routing for the Deliverect aggregator. Tokens are
          encrypted at rest. Leave a token field blank to keep the existing value.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-6" onSubmit={onSubmit}>
          <div className="flex items-center gap-2">
            <Checkbox
              id="deliverect-enabled"
              checked={draft.enabled}
              onCheckedChange={(value) =>
                patch((prev) => ({ ...prev, enabled: value === true }))
              }
            />
            <Label htmlFor="deliverect-enabled" className="font-normal">
              Enable Deliverect integration
            </Label>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="deliverect-environment">Environment</Label>
              <Select
                value={draft.environment}
                onValueChange={(value) =>
                  patch((prev) => ({
                    ...prev,
                    environment: value === "production" ? "production" : "staging"
                  }))
                }
              >
                <SelectTrigger id="deliverect-environment">
                  <SelectValue placeholder="staging" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="staging">Staging</SelectItem>
                  <SelectItem value="production">Production</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label htmlFor="deliverect-external-location">External location ID</Label>
              <Input
                id="deliverect-external-location"
                type="text"
                value={draft.externalLocationId}
                onChange={(event) =>
                  patch((prev) => ({ ...prev, externalLocationId: event.target.value }))
                }
                placeholder="LOC-123"
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor="deliverect-provider-location">Provider location ID</Label>
              <Input
                id="deliverect-provider-location"
                type="text"
                value={draft.providerLocationId}
                onChange={(event) =>
                  patch((prev) => ({ ...prev, providerLocationId: event.target.value }))
                }
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor="deliverect-channel-link">Channel link ID</Label>
              <Input
                id="deliverect-channel-link"
                type="text"
                value={draft.channelLinkId}
                onChange={(event) =>
                  patch((prev) => ({ ...prev, channelLinkId: event.target.value }))
                }
              />
            </div>

            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="deliverect-api-token">API token</Label>
              <div className="flex gap-2">
                <Input
                  id="deliverect-api-token"
                  type={showApiToken ? "text" : "password"}
                  autoComplete="off"
                  value={draft.apiToken}
                  onChange={(event) =>
                    patch((prev) => ({ ...prev, apiToken: event.target.value }))
                  }
                  placeholder={initial?.apiTokenMask ?? "Paste a new API token"}
                  className="font-mono"
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setShowApiToken((v) => !v)}
                >
                  {showApiToken ? "Hide" : "Show"}
                </Button>
              </div>
              {initial?.apiTokenMask ? (
                <p className="text-xs text-muted-foreground">
                  Current token: <span className="font-mono">{initial.apiTokenMask}</span>. Leave
                  blank to keep.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Not yet configured. Paste the Deliverect API token issued to your account.
                </p>
              )}
            </div>

            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="deliverect-hmac-secret">Webhook HMAC secret</Label>
              <div className="flex gap-2">
                <Input
                  id="deliverect-hmac-secret"
                  type={showHmacSecret ? "text" : "password"}
                  autoComplete="off"
                  value={draft.hmacSecret}
                  onChange={(event) =>
                    patch((prev) => ({ ...prev, hmacSecret: event.target.value }))
                  }
                  placeholder={initial?.hmacSecretMask ?? "Paste the HMAC signing secret"}
                  className="font-mono"
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setShowHmacSecret((v) => !v)}
                >
                  {showHmacSecret ? "Hide" : "Show"}
                </Button>
              </div>
              {initial?.hmacSecretMask ? (
                <p className="text-xs text-muted-foreground">
                  HMAC secret is configured. Leave blank to keep the existing value.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Used to verify Deliverect webhook signatures. Must match the secret configured
                  in the Deliverect dashboard.
                </p>
              )}
            </div>
          </div>

          {update.isError ? (
            <Alert variant="destructive">
              <AlertTitle>Could not save Deliverect settings</AlertTitle>
              <AlertDescription>
                {update.error instanceof Error ? update.error.message : "Unknown error"}
              </AlertDescription>
            </Alert>
          ) : null}

          {update.isSuccess && savedTick > 0 ? (
            <Alert>
              <AlertTitle>Settings saved</AlertTitle>
              <AlertDescription>
                Deliverect credentials updated. Webhook verification will use the new HMAC secret
                immediately.
              </AlertDescription>
            </Alert>
          ) : null}

          <div className="flex items-center justify-end gap-2">
            <Button type="submit" disabled={update.isPending}>
              {update.isPending ? "Saving..." : "Save"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
