#!/usr/bin/env node
// @ts-check
/**
 * DeepSeek first-deploy smoke test — see docs/deepseek-smoke-test.md.
 *
 * Hits the REAL `api.deepseek.com` (unit tests mock the provider, so nothing
 * else in CI exercises the live key / model ids). Run AFTER a deploy, or
 * locally before a deploy, to catch the failure modes a chat request would
 * otherwise surface to an operator first: revoked key, model-id mismatch,
 * region/network block.
 *
 * Usage:
 *   pnpm --filter @rop/backoffice-web ai:smoke
 *   DEEPSEEK_API_KEY=sk-... node apps/backoffice-web/scripts/ai-smoke.mjs
 *
 * Reads the key from $DEEPSEEK_API_KEY only. This script does NOT read the
 * `ai.deepseek_api_key` AppSetting row (that lives in the DB, behind the app's
 * decryption layer) — so when verifying a deploy whose key lives in AppSetting,
 * paste the same key into the env for this one-shot check. It tests the
 * upstream contract, not where the running app sources its key.
 *
 * Exit code is non-zero if any check fails. No key material is printed.
 */

const BASE_URL = "https://api.deepseek.com";
const MODELS = ["deepseek-v4-pro", "deepseek-v4-flash"];

const apiKey = (process.env.DEEPSEEK_API_KEY ?? "").trim();
if (!apiKey) {
  console.error(
    "DEEPSEEK_API_KEY is not set. Export the operator key (the same value stored\n" +
      "in /settings/ai or the stack env) and re-run, e.g.\n" +
      "  DEEPSEEK_API_KEY=sk-... pnpm --filter @rop/backoffice-web ai:smoke",
  );
  process.exit(2);
}

const authHeader = { Authorization: `Bearer ${apiKey}` };
let failures = 0;

function pass(msg) {
  console.log(`  ok   ${msg}`);
}
function fail(msg) {
  failures += 1;
  console.error(`  FAIL ${msg}`);
}

/** GET /v1/models — proves the key is live and the account can list models. */
async function checkModelList() {
  console.log("1. GET /v1/models (key liveness)");
  try {
    const res = await fetch(`${BASE_URL}/v1/models`, { headers: authHeader });
    if (res.status === 401 || res.status === 403) {
      fail(`/v1/models -> ${res.status} (key revoked or lacks scope)`);
      return;
    }
    if (!res.ok) {
      fail(`/v1/models -> ${res.status} ${res.statusText}`);
      return;
    }
    const body = await res.json().catch(() => null);
    const ids = Array.isArray(body?.data)
      ? body.data.map((m) => m?.id).filter(Boolean)
      : [];
    pass(`/v1/models -> 200 (${ids.length} models visible)`);
    for (const id of MODELS) {
      if (ids.includes(id)) {
        pass(`model "${id}" present in /v1/models`);
      } else {
        // Not fatal on its own — DeepSeek does not always advertise every
        // chat alias here — but worth surfacing. The chat ping below is the
        // authoritative per-model check.
        console.warn(`  warn model "${id}" not listed in /v1/models (chat ping is authoritative)`);
      }
    }
  } catch (err) {
    fail(`/v1/models request threw: ${describe(err)} (region block / DNS / TLS?)`);
  }
}

/**
 * POST /chat/completions — 1-token ping per model. DeepSeek speaks the
 * OpenAI-compatible Chat Completions API; the app uses `provider.chat(modelId)`
 * (NOT the Responses API — that 404s on DeepSeek, per ADR-0017 §5).
 *
 * @param {string} model
 * @param {boolean} thinking  attach reasoning toggle (mirrors ai.thinking_mode)
 */
async function chatPing(model, thinking) {
  const label = `chat "${model}"${thinking ? " (thinking)" : ""}`;
  const body = {
    model,
    messages: [{ role: "user", content: "ping" }],
    max_tokens: 1,
    stream: false,
  };
  // The app passes `providerOptions.deepseek.thinking.type: "enabled"`, which
  // the Vercel SDK serializes onto the request. We exercise the documented
  // wire shape here so a thinking-mode rollout is covered too.
  if (thinking) {
    body.thinking = { type: "enabled" };
  }
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { ...authHeader, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      fail(`${label} -> ${res.status} ${res.statusText} ${truncate(detail)}`);
      return;
    }
    const json = await res.json().catch(() => null);
    const finish = json?.choices?.[0]?.finish_reason ?? "?";
    pass(`${label} -> 200 (finish_reason=${finish})`);
  } catch (err) {
    fail(`${label} request threw: ${describe(err)}`);
  }
}

function truncate(s) {
  if (typeof s !== "string") return "";
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > 160 ? `${oneLine.slice(0, 160)}…` : oneLine;
}

function describe(err) {
  return err instanceof Error ? err.message : String(err);
}

async function main() {
  console.log(`DeepSeek smoke test against ${BASE_URL}\n`);
  await checkModelList();
  console.log("\n2. POST /chat/completions (1-token ping per model)");
  for (const model of MODELS) {
    await chatPing(model, false);
  }
  console.log("\n3. Thinking-mode ping (default model only)");
  await chatPing(MODELS[0], true);

  console.log("");
  if (failures > 0) {
    console.error(`Smoke test FAILED: ${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("Smoke test passed: key live, both models reachable, thinking-mode accepted.");
}

main().catch((err) => {
  console.error(`Smoke test crashed: ${describe(err)}`);
  process.exit(1);
});
