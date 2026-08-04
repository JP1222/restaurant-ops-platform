"use client";

import {
  ChevronDown,
  Gauge,
  KeyRound,
  LifeBuoy,
  ShieldAlert,
  SlidersHorizontal,
  TriangleAlert,
  Workflow,
  Zap,
} from "lucide-react";
import { type ComponentProps, type ReactNode, useState } from "react";
import {
  aiChatProviders,
  aiModelIds,
  type AppSettingRead,
  type SettingKey,
} from "@rop/contracts";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useAppSettings, useSettingsSave } from "@/hooks/use-app-settings";
import { CommitField } from "../commit-field";
import { NumberField } from "../number-field";
import { SecretInput } from "../secret-input";
import { SettingRow as SettingRowBase } from "../setting-row";
import { StatusPill } from "../status-pill";
import { AiUsageCard } from "./ai-usage-card";
import { SettingsCard } from "./settings-card";

interface SecretAware extends AppSettingRead {
  valuePresent?: boolean;
  /** Last 4 chars of the stored value (added by the settings list endpoint). Never the full value. */
  maskedTail?: string | null;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}
function asBoolean(value: unknown): boolean {
  return value === true;
}
function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

const ENV_NOTE = (
  <span className="block text-ws-marketing">
    Set at deploy time. Saving here writes a database override that takes precedence — a redeploy
    won&apos;t revert it.
  </span>
);

// Human labels for the chat / matcher provider selectors.
const PROVIDER_LABELS: Record<string, string> = {
  deepseek: "DeepSeek (text)",
  gemini: "Google Gemini (multimodal)",
  openai: "OpenAI",
  anthropic: "Anthropic Claude",
  "openai-compatible": "OpenAI-compatible endpoint",
};

// Placeholder model id per provider, to nudge the free-form input.
const MODEL_PLACEHOLDER: Record<string, string> = {
  deepseek: "deepseek-v4-pro",
  gemini: "gemini-2.5-flash",
  openai: "gpt-4o",
  anthropic: "claude-sonnet-4-6",
  "openai-compatible": "gpt-4o-mini",
};

// The Providers & keys card renders one row per credential, in this order, with a
// friendly name + capability sub-label. Driven off the `category=secret` rows but
// ordered/labelled here (the registry `description` is technical context, not UI copy).
const PROVIDER_KEY_ORDER: SettingKey[] = [
  "ai.deepseek_api_key",
  "ai.openai_api_key",
  "ai.anthropic_api_key",
  "ai.vision_api_key",
  "ai.chat_api_key",
];
const PROVIDER_KEY_META: Record<string, { name: string; capability: string }> = {
  "ai.deepseek_api_key": { name: "DeepSeek", capability: "Text only" },
  "ai.openai_api_key": { name: "OpenAI", capability: "Text + vision" },
  "ai.anthropic_api_key": { name: "Anthropic Claude", capability: "Text + vision" },
  "ai.vision_api_key": { name: "Google Gemini", capability: "Text + vision · also powers invoice scan" },
  "ai.chat_api_key": { name: "OpenAI-compatible endpoint", capability: "Self-hosted / proxy · needs a base URL" },
};

export function AiPanel() {
  const { data, isLoading, isError, error } = useAppSettings();

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading settings…</p>;
  }
  if (isError) {
    return (
      <Alert variant="destructive" className="border-destructive/40 bg-destructive-soft">
        <TriangleAlert />
        <AlertTitle>Couldn&apos;t load settings</AlertTitle>
        <AlertDescription>{error.message}</AlertDescription>
      </Alert>
    );
  }
  if (!data) return null;

  const aiSettings = data.settings.filter((s) => s.category === "ai" || s.category === "secret");
  return <AiPanelForm settings={aiSettings} />;
}

function AiPanelForm({ settings }: { settings: AppSettingRead[] }) {
  const { update, updateAsync, status } = useSettingsSave();
  const [confirmKill, setConfirmKill] = useState(false);
  const [disconnectKey, setDisconnectKey] = useState<SettingKey | null>(null);

  const get = (key: SettingKey) => settings.find((s) => s.key === key);

  const noteFor = (row: AppSettingRead | undefined) => (row?.source === "env" ? ENV_NOTE : null);

  const chatProvider = get("ai.chat_provider");
  const modelId = get("ai.model_id");
  const chatBaseUrl = get("ai.chat_base_url");
  const matchProvider = get("ai.match_provider");
  const matchModelId = get("ai.match_model_id");
  const visionModelId = get("ai.vision_model_id");
  const visionFallbackModel = get("ai.vision_fallback_model_id");
  const textFallbackModel = get("ai.text_fallback_model_id");
  const emojiSuggest = get("ai.emoji_suggest_enabled");
  const visionFallback = get("ai.vision_fallback_enabled");
  const thinking = get("ai.thinking_mode");
  const maxTokens = get("ai.max_output_tokens");
  const rateLimit = get("ai.rate_limit_per_minute");
  const scanRateLimit = get("ai.scan_rate_limit_per_minute");
  const systemPrompt = get("ai.system_prompt_append");
  const killSwitch = get("ai.kill_switch");

  const killOn = asBoolean(killSwitch?.value);
  const providerValue = asString(chatProvider?.value, "deepseek");
  const currentModelId = asString(modelId?.value, "deepseek-v4-pro");
  const matchProviderValue = asString(matchProvider?.value, "deepseek");
  const currentMatchModelId = asString(matchModelId?.value, "deepseek-v4-pro");

  // Provider and model id are separate settings, so a naive provider switch leaves
  // a DeepSeek alias in ai.model_id — and the next chat sends e.g. "deepseek-v4-pro"
  // to Gemini, which rejects it (the stream errors with no UI hint). Keep them
  // coherent: when switching AWAY from DeepSeek and the id is still a DeepSeek alias,
  // drop in the new provider's placeholder; when switching BACK to DeepSeek from a
  // foreign id, restore a valid dropdown value. Never clobber a custom id the
  // operator already typed for that family.
  const handleProviderChange = (next: string) => {
    update("ai.chat_provider", next);
    const isDeepSeekAlias = (aiModelIds as readonly string[]).includes(currentModelId);
    if (next !== "deepseek" && isDeepSeekAlias) {
      update("ai.model_id", MODEL_PLACEHOLDER[next] ?? currentModelId);
    } else if (next === "deepseek" && !isDeepSeekAlias) {
      update("ai.model_id", "deepseek-v4-pro");
    }
  };

  // Same coherence guard for the receipt matcher's own provider/model pair (see above):
  // keep ai.match_model_id valid for the newly chosen ai.match_provider.
  const handleMatchProviderChange = (next: string) => {
    update("ai.match_provider", next);
    const isDeepSeekAlias = (aiModelIds as readonly string[]).includes(currentMatchModelId);
    if (next !== "deepseek" && isDeepSeekAlias) {
      update("ai.match_model_id", MODEL_PLACEHOLDER[next] ?? currentMatchModelId);
    } else if (next === "deepseek" && !isDeepSeekAlias) {
      update("ai.match_model_id", "deepseek-v4-pro");
    }
  };

  // The model control: a dropdown of the DeepSeek aliases when the provider is DeepSeek,
  // a free-form id field otherwise (Gemini / OpenAI / Anthropic / openai-compatible ids).
  const renderModelField = (
    id: string,
    provider: string,
    value: string,
    onCommit: (next: string) => void,
  ) =>
    provider === "deepseek" ? (
      <Select value={value || "deepseek-v4-pro"} onValueChange={onCommit}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {aiModelIds.map((m) => (
            <SelectItem key={m} value={m}>
              {m}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    ) : (
      <CommitField
        id={id}
        value={value}
        placeholder={MODEL_PLACEHOLDER[provider] ?? "model-id"}
        onCommit={onCommit}
      />
    );

  const providerSelect = (id: string, value: string, onChange: (next: string) => void) => (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {aiChatProviders.map((p) => (
          <SelectItem key={p} value={p}>
            {PROVIDER_LABELS[p] ?? p}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <div className="space-y-4">
      {killOn ? (
        <Alert variant="destructive" className="border-destructive/40 bg-destructive-soft">
          <TriangleAlert />
          <AlertTitle>AI assistant is disabled</AlertTitle>
          <AlertDescription>
            The kill switch is on. All chat requests return 503 until you toggle it off.
          </AlertDescription>
          <AlertAction>
            <Button variant="destructive" size="sm" onClick={() => update("ai.kill_switch", false)}>
              Re-enable
            </Button>
          </AlertAction>
        </Alert>
      ) : null}

      {/* Info strip — the one genuinely global line (no redundant status pill; connection
          status lives per-credential in Providers & keys below). */}
      <div className="flex items-center gap-3 rounded-xl border bg-card px-4 py-3 shadow-sm">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
          <Zap className="size-4.5" />
        </div>
        <p className="text-sm text-muted-foreground">
          Changes save instantly and apply to the next request — no restart or redeploy.
        </p>
      </div>

      {/* 1 — Providers & keys: credentials only, with per-credential connection status. */}
      <SettingsCard
        icon={KeyRound}
        title="Providers & keys"
        description="Credentials only — add an API key for each provider. Which model powers each feature is set below."
      >
        {PROVIDER_KEY_ORDER.map((key) => {
          const secret = get(key) as SecretAware | undefined;
          if (!secret) return null;
          const meta = PROVIDER_KEY_META[key];
          return (
            <ProviderKeyRow
              key={key}
              settingKey={key}
              name={meta?.name ?? key}
              capability={meta?.capability ?? ""}
              valuePresent={secret.valuePresent ?? false}
              maskedTail={secret.maskedTail ?? null}
              onRotate={async (next) => {
                await updateAsync(key, next);
              }}
              onDisconnect={() => setDisconnectKey(key)}
              // The OpenAI-compatible endpoint also needs its base URL — surfaced as an
              // Advanced disclosure on its own row (it's that provider's config, not global).
              advanced={
                key === "ai.chat_api_key" && chatBaseUrl ? (
                  <div className="w-full">
                    <CommitField
                      id="ai-chat-base-url"
                      value={asString(chatBaseUrl.value, "")}
                      placeholder="https://api.openai.com/v1"
                      onCommit={(value) => update("ai.chat_base_url", value)}
                    />
                    {chatBaseUrl.source === "env" ? (
                      <div className="pt-1 text-right text-xs leading-snug">{ENV_NOTE}</div>
                    ) : null}
                    <div className="flex justify-end pt-1">
                      <StatusPill status={status("ai.chat_base_url")} />
                    </div>
                  </div>
                ) : null
              }
            />
          );
        })}
      </SettingsCard>

      {/* 2 — Feature models: which model powers each feature. */}
      <SettingsCard
        icon={Workflow}
        title="Feature models"
        description="Point each feature at a provider + model. Chat, vision, and matching are independent — switching one never disturbs the others."
      >
        <SubBlock
          title="Chat assistant"
          description="The brain behind the floating assistant."
        >
          {chatProvider ? (
            <SettingRow
              label="Provider"
              source={chatProvider.source}
              htmlFor="ai-chat-provider"
              status={status("ai.chat_provider")}
              note={noteFor(chatProvider)}
            >
              {providerSelect("ai-chat-provider", providerValue, handleProviderChange)}
            </SettingRow>
          ) : null}
          {modelId ? (
            <SettingRow
              label="Model"
              source={modelId.source}
              htmlFor="ai-model-id"
              status={status("ai.model_id")}
              note={noteFor(modelId)}
            >
              {renderModelField("ai-model-id", providerValue, asString(modelId.value, ""), (value) =>
                update("ai.model_id", value),
              )}
            </SettingRow>
          ) : null}
        </SubBlock>

        <SubBlock
          title="Vision model"
          description="Reads any image task — invoice scan AND the chat image-fallback below. Google Gemini, using the Gemini key."
        >
          {visionModelId ? (
            <SettingRow
              label="Vision model"
              source={visionModelId.source}
              htmlFor="ai-vision-model-id"
              status={status("ai.vision_model_id")}
              note={noteFor(visionModelId)}
            >
              <CommitField
                id="ai-vision-model-id"
                value={asString(visionModelId.value, "gemini-flash-latest")}
                placeholder="gemini-flash-latest"
                onCommit={(value) => update("ai.vision_model_id", value)}
              />
            </SettingRow>
          ) : null}
          {visionFallback ? (
            <SettingRow
              label="Image chat fallback"
              description={visionFallback.description}
              source={visionFallback.source}
              htmlFor="ai-vision-fallback"
              status={status("ai.vision_fallback_enabled")}
              note={noteFor(visionFallback)}
            >
              <Switch
                id="ai-vision-fallback"
                className="data-checked:bg-accent"
                checked={asBoolean(visionFallback.value)}
                onCheckedChange={(checked) => update("ai.vision_fallback_enabled", checked)}
              />
            </SettingRow>
          ) : null}
        </SubBlock>

        <SubBlock
          title="Receipt matcher"
          description="Matches scanned invoice lines to your catalog and suggests item emoji. A text model — separate from the vision model that reads the image."
        >
          {matchProvider ? (
            <SettingRow
              label="Provider"
              source={matchProvider.source}
              htmlFor="ai-match-provider"
              status={status("ai.match_provider")}
              note={noteFor(matchProvider)}
            >
              {providerSelect("ai-match-provider", matchProviderValue, handleMatchProviderChange)}
            </SettingRow>
          ) : null}
          {matchModelId ? (
            <SettingRow
              label="Model"
              source={matchModelId.source}
              htmlFor="ai-match-model-id"
              status={status("ai.match_model_id")}
              note={noteFor(matchModelId)}
            >
              {renderModelField(
                "ai-match-model-id",
                matchProviderValue,
                asString(matchModelId.value, ""),
                (value) => update("ai.match_model_id", value),
              )}
            </SettingRow>
          ) : null}
        </SubBlock>
      </SettingsCard>

      {/* 3 — Fallback model: one place for every retry-once-on-failure backup, by modality. */}
      <SettingsCard
        icon={LifeBuoy}
        title="Fallback model"
        description="A backup model tried once when the primary fails with a transient error. Leave empty for no fallback."
      >
        {textFallbackModel ? (
          <SettingRow
            label="Text fallback"
            description="Backup for the unattended scan-flow text calls (receipt matcher + emoji). Runs on the matcher's provider. The chat assistant is interactive, so it isn't on this path."
            source={textFallbackModel.source}
            htmlFor="ai-text-fallback-model-id"
            status={status("ai.text_fallback_model_id")}
            note={noteFor(textFallbackModel)}
          >
            <CommitField
              id="ai-text-fallback-model-id"
              value={asString(textFallbackModel.value, "")}
              placeholder="deepseek-v4-flash  ·  empty = no fallback"
              onCommit={(value) => update("ai.text_fallback_model_id", value)}
            />
          </SettingRow>
        ) : null}
        {visionFallbackModel ? (
          <SettingRow
            label="Vision fallback"
            description="Backup Gemini model for invoice scan, tried once on a transient overload."
            source={visionFallbackModel.source}
            htmlFor="ai-vision-fallback-model-id"
            status={status("ai.vision_fallback_model_id")}
            note={noteFor(visionFallbackModel)}
          >
            <CommitField
              id="ai-vision-fallback-model-id"
              value={asString(visionFallbackModel.value, "")}
              placeholder="gemini-3.1-flash-lite  ·  empty = no fallback"
              onCommit={(value) => update("ai.vision_fallback_model_id", value)}
            />
          </SettingRow>
        ) : null}
      </SettingsCard>

      {/* 4 — Behavior. */}
      <SettingsCard
        icon={SlidersHorizontal}
        title="Behavior"
        description="How the assistant thinks and writes."
      >
        {thinking ? (
          <SettingRow
            label="Thinking mode"
            description={thinking.description}
            source={thinking.source}
            htmlFor="ai-thinking-mode"
            status={status("ai.thinking_mode")}
            note={noteFor(thinking)}
          >
            <Switch
              id="ai-thinking-mode"
              className="data-checked:bg-accent"
              checked={asBoolean(thinking.value)}
              onCheckedChange={(checked) => update("ai.thinking_mode", checked)}
            />
          </SettingRow>
        ) : null}
        {emojiSuggest ? (
          <SettingRow
            label="Auto emoji icons"
            description={emojiSuggest.description}
            source={emojiSuggest.source}
            htmlFor="ai-emoji-suggest"
            status={status("ai.emoji_suggest_enabled")}
            note={noteFor(emojiSuggest)}
          >
            <Switch
              id="ai-emoji-suggest"
              className="data-checked:bg-accent"
              checked={asBoolean(emojiSuggest.value)}
              onCheckedChange={(checked) => update("ai.emoji_suggest_enabled", checked)}
            />
          </SettingRow>
        ) : null}
        {maxTokens ? (
          <SettingRow
            label="Max output tokens"
            description={maxTokens.description}
            source={maxTokens.source}
            htmlFor="ai-max-output-tokens"
            status={status("ai.max_output_tokens")}
            note={noteFor(maxTokens)}
          >
            <NumberField
              id="ai-max-output-tokens"
              value={asNumber(maxTokens.value, 4000)}
              min={100}
              max={32000}
              onCommit={(value) => update("ai.max_output_tokens", value)}
            />
          </SettingRow>
        ) : null}
        {systemPrompt ? (
          <SettingRow
            label="System prompt append"
            description={systemPrompt.description}
            source={systemPrompt.source}
            htmlFor="ai-system-prompt"
            full
            status={status("ai.system_prompt_append")}
            note={noteFor(systemPrompt)}
          >
            <CommitField
              id="ai-system-prompt"
              as="textarea"
              rows={4}
              maxLength={2000}
              showCount
              placeholder="Optional context appended to the base system prompt."
              value={asString(systemPrompt.value, "")}
              onCommit={(value) => update("ai.system_prompt_append", value)}
            />
          </SettingRow>
        ) : null}
      </SettingsCard>

      {/* 5 — Rate limits + Safety (kill switch lives here, not mixed into model config). */}
      <SettingsCard
        icon={Gauge}
        title="Rate limits"
        description="Per-minute ceilings shared across all staff, plus the emergency safety switch."
      >
        {rateLimit ? (
          <SettingRow
            label="Chat rate limit"
            description={rateLimit.description}
            source={rateLimit.source}
            htmlFor="ai-rate-limit"
            status={status("ai.rate_limit_per_minute")}
            note={noteFor(rateLimit)}
          >
            <NumberField
              id="ai-rate-limit"
              value={asNumber(rateLimit.value, 10)}
              min={1}
              max={1000}
              unit="req/min"
              onCommit={(value) => update("ai.rate_limit_per_minute", value)}
            />
          </SettingRow>
        ) : null}
        {scanRateLimit ? (
          <SettingRow
            label="Scan rate limit"
            description={scanRateLimit.description}
            source={scanRateLimit.source}
            htmlFor="ai-scan-rate-limit"
            status={status("ai.scan_rate_limit_per_minute")}
            note={noteFor(scanRateLimit)}
          >
            <NumberField
              id="ai-scan-rate-limit"
              value={asNumber(scanRateLimit.value, 20)}
              min={1}
              max={1000}
              unit="req/min"
              onCommit={(value) => update("ai.scan_rate_limit_per_minute", value)}
            />
          </SettingRow>
        ) : null}

        {killSwitch ? (
          <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive-soft/40 px-4 [--settings-row-y:0.875rem]">
            <div className="flex items-center gap-2 pt-3 text-xs font-semibold uppercase tracking-wide text-destructive">
              <ShieldAlert className="size-3.5" /> Safety
            </div>
            <SettingRow
              label="Kill switch"
              description={killSwitch.description}
              source={killSwitch.source}
              htmlFor="ai-kill-switch"
              tone="danger"
              status={status("ai.kill_switch")}
            >
              <Switch
                id="ai-kill-switch"
                className="data-checked:bg-destructive"
                checked={killOn}
                onCheckedChange={(checked) => {
                  if (checked) setConfirmKill(true);
                  else update("ai.kill_switch", false);
                }}
              />
            </SettingRow>
          </div>
        ) : null}
      </SettingsCard>

      {/* 6 — Usage & cost (reads ai_usage_events via /api/ai/usage). */}
      <AiUsageCard />

      <AlertDialog open={confirmKill} onOpenChange={setConfirmKill}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Turn on the kill switch?</AlertDialogTitle>
            <AlertDialogDescription>
              This immediately returns 503 for every AI chat request across the backoffice until you
              turn it back off. Use it only to stop a runaway or compromised assistant.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => update("ai.kill_switch", true)}>
              Disable AI now
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={disconnectKey !== null} onOpenChange={(open) => !open && setDisconnectKey(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect this provider?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the stored API key. Any feature pointed at this provider will return a
              configuration error until you add a key again. You can reconnect at any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={async () => {
                if (disconnectKey) await updateAsync(disconnectKey, "");
                setDisconnectKey(null);
              }}
            >
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// On this dense page, every row shows its description as a hover ⓘ tooltip instead of an
// always-on paragraph. The rest of Settings keeps inline descriptions — AI is the one
// opt-in surface — so this thin wrapper injects descriptionTooltip into the shared row.
function SettingRow(props: ComponentProps<typeof SettingRowBase>) {
  return <SettingRowBase {...props} descriptionTooltip />;
}

// A labeled, bordered group inside a card (the Feature-models sub-blocks). Tightens the
// row rhythm via the --settings-row-y knob SettingRow reads.
function SubBlock({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="mb-3 rounded-lg border bg-muted/30 px-4 pt-3 pb-1 last:mb-0 [--settings-row-y:0.75rem]">
      <div className="text-sm font-medium">{title}</div>
      <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      <div className="mt-1">{children}</div>
    </div>
  );
}

// One credential row in Providers & keys: provider name + a per-credential connection
// pill, a capability sub-label, the masked SecretInput (with last-4 tail), a Disconnect
// action when a key is present, and an optional Advanced disclosure (the OpenAI-compatible
// endpoint's base URL). Mirrors SettingRow's flex/padding so spacing stays consistent.
function ProviderKeyRow({
  settingKey,
  name,
  capability,
  valuePresent,
  maskedTail,
  onRotate,
  onDisconnect,
  advanced,
}: {
  settingKey: SettingKey;
  name: string;
  capability: string;
  valuePresent: boolean;
  maskedTail: string | null;
  onRotate: (next: string) => Promise<void> | void;
  onDisconnect: () => void;
  advanced?: ReactNode;
}) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  return (
    <div className="flex flex-wrap items-start justify-between gap-6 border-b py-[var(--settings-row-y,1.125rem)] last:border-b-0">
      <div className="min-w-0 space-y-1" style={{ flex: "1 1 240px" }}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{name}</span>
          <ConnectionPill connected={valuePresent} />
        </div>
        {capability ? <p className="text-xs text-muted-foreground">{capability}</p> : null}
      </div>
      <div className="flex w-90 shrink-0 flex-col items-end gap-1.5">
        <div className="w-full">
          <SecretInput
            settingKey={settingKey}
            valuePresent={valuePresent}
            maskedTail={maskedTail}
            onRotate={onRotate}
          />
        </div>
        <div className="flex items-center gap-3">
          {advanced ? (
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
              aria-expanded={showAdvanced}
            >
              <ChevronDown className={cn("size-3 transition-transform", showAdvanced && "rotate-180")} />
              Advanced · Base URL
            </button>
          ) : null}
          {valuePresent ? (
            <button
              type="button"
              onClick={onDisconnect}
              className="text-xs font-medium text-muted-foreground hover:text-destructive"
            >
              Disconnect
            </button>
          ) : null}
        </div>
        {advanced && showAdvanced ? <div className="w-full pt-1">{advanced}</div> : null}
      </div>
    </div>
  );
}

function ConnectionPill({ connected }: { connected: boolean }) {
  return connected ? (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent">
      <span className="size-1.5 rounded-full bg-accent" />
      Connected
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
      <span className="size-1.5 rounded-full bg-muted-foreground/40" />
      No key
    </span>
  );
}
