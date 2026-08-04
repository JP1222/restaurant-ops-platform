# DeepSeek first-deploy smoke test

First-real-API verification for the Backoffice AI assistant after a deploy.

## Why this exists

The unit suite mocks the provider — `apps/backoffice-web/tests/api/ai-chat.test.ts`
does `vi.mock("@/lib/ai/deepseek-provider", …)`, and nothing in CI ever calls
`api.deepseek.com`. So the first time the live key, model ids, and network path
are exercised is an operator's first chat. The failure modes that hides:

- **Key revoked / wrong key** → chat route returns `503 auth_not_configured`.
- **Model-id mismatch** → DeepSeek renamed or deprecated a model and the
  `ai.model_id` AppSetting (`deepseek-v4-pro` / `deepseek-v4-flash`) no longer
  resolves. (The legacy `deepseek-chat` / `deepseek-reasoner` aliases were
  deprecated by DeepSeek on 2026-07-24 and are deliberately **not** in our enum —
  see [ADR-0017](decisions/0017-deepseek-replaces-codex.md) §3.)
- **Region / network block** → the Oracle host can't reach `api.deepseek.com`.

This procedure replaces the Codex-era `docs/phase-7-cluster-b-smoke.md`,
which was a one-time Codex-OAuth pre-flight and is now historical.

## Where the key lives

Per [ADR-0017](decisions/0017-deepseek-replaces-codex.md) and the 2026-05-27
AppSetting-as-secret-store pivot, the running app resolves its key in this order
(`apps/backoffice-web/lib/ai/deepseek-provider.ts`):

1. `ai.deepseek_api_key` AppSetting row (`category=secret`, encrypted at rest),
   set by an operator at `/settings/ai`.
2. `process.env.DEEPSEEK_API_KEY` (Dokploy env) — transition fallback.

**This smoke test reads the key from `$DEEPSEEK_API_KEY` only.** It checks the
*upstream contract* (is the key live, are the models reachable), not where the
deployed app sources its key. If the deploy stores the key in AppSetting, paste
that same value into the shell for this one-shot check:

```bash
export DEEPSEEK_API_KEY='sk-…'   # the operator key, same value as /settings/ai
```

Never paste the key into a committed file or a shared terminal log. Every command
below captures only HTTP status codes and finish reasons — no key material, no
response bodies that could echo the key.

## 1. Key liveness — `GET /v1/models`

```bash
curl -sS -o /dev/null -w '%{http_code}\n' \
  https://api.deepseek.com/v1/models \
  -H "Authorization: Bearer ${DEEPSEEK_API_KEY}"
```

Expect **`200`**. `401` / `403` = key revoked or lacks scope. A hang or a
connection error = region / DNS / TLS block from this host.

To eyeball which model ids the account advertises:

```bash
curl -sS https://api.deepseek.com/v1/models \
  -H "Authorization: Bearer ${DEEPSEEK_API_KEY}" \
  | grep -o '"id":"[^"]*"'
```

`/v1/models` does not always advertise every chat alias, so the per-model chat
ping below is the authoritative check.

## 2. One-token chat ping per model

DeepSeek speaks the OpenAI-compatible **Chat Completions** API. The app calls
`provider.chat(modelId)` — **not** the Responses API, which 404s on DeepSeek
(ADR-0017 §5). Ping each model in our enum with `max_tokens: 1`:

```bash
for MODEL in deepseek-v4-pro deepseek-v4-flash; do
  printf '%s -> ' "$MODEL"
  curl -sS -o /dev/null -w '%{http_code}\n' \
    https://api.deepseek.com/chat/completions \
    -H "Authorization: Bearer ${DEEPSEEK_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"${MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}],\"max_tokens\":1,\"stream\":false}"
done
```

Expect `deepseek-v4-pro -> 200` and `deepseek-v4-flash -> 200`. A `400` with a
model-not-found body means the id drifted — reconcile
`packages/contracts/src/settings.ts` (`aiModelIds`) with DeepSeek's current
catalog before the operator hits it in chat.

## 3. Thinking-mode ping (optional)

When `ai.thinking_mode` (boolean AppSetting, default false) is on, the chat route
attaches `providerOptions.deepseek.thinking.type: "enabled"`. Confirm the upstream
accepts the toggle for the default model:

```bash
curl -sS -o /dev/null -w 'thinking -> %{http_code}\n' \
  https://api.deepseek.com/chat/completions \
  -H "Authorization: Bearer ${DEEPSEEK_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4-pro","messages":[{"role":"user","content":"ping"}],"max_tokens":1,"stream":false,"thinking":{"type":"enabled"}}'
```

Expect **`200`**.

## 4. End-to-end via the FAB (authoritative)

The curls above prove the upstream contract. The deployed app's own key
resolution + auth + tools are only proven through the product:

1. Open `https://backoffice.example.com/` and sign in.
2. Click the **Sparkles FAB** (bottom-right, on every authenticated page).
3. Ask: **"what does today look like?"** — expect a streaming answer grounded in
   analytics, not a `503 auth_not_configured` error toast.
4. Open the History icon → the conversation appears in the list (persistence OK).

If steps 1–3 pass but the FAB errors, the key is live upstream but the deployed
app can't see it — check the `ai.deepseek_api_key` AppSetting row at
`/settings/ai`, or the `DEEPSEEK_API_KEY` env fallback in Dokploy.

## Scripted equivalent

The same `/v1/models` + per-model chat pings + thinking-mode ping run from one
command (exits non-zero on any failure, prints no key material):

```bash
DEEPSEEK_API_KEY='sk-…' pnpm --filter @rop/backoffice-web ai:smoke
```

Source: `apps/backoffice-web/scripts/ai-smoke.mjs`. Pure Node `fetch`, no extra
deps. Use it from CI-adjacent shells or the Oracle host; it does not read the
AppSetting DB row (see "Where the key lives" above).
