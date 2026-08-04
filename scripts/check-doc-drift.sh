#!/bin/sh
set -eu

fail=0

echo "Checking stale documentation references..."
# Scope: top-level docs AND every app's internal docs/ tree. The :(glob) magic
# on the last pathspec is required, not stylistic: a bare `apps/*/docs` matches
# ZERO tracked files (a git pathspec is not a shell glob — `*` won't span the
# trailing path), which is exactly how dev-machine paths hid in
# apps/analytics-api/docs/plan.md until PR #506. Keep the :(glob)…/** form.
if git grep -n -E 'phase-2-plan|Phase 2 Implementation|/Users/example|/Users/example-org|iPad Air 13-inch \(M4\)|source of truth for Phase|Codex CLI Profile and MCP Setup|MCP server entries' -- \
  README.md AGENTS.md docs .env.example docker-compose.dev.yml apps/kds-api/AGENTS.md apps/kds-web/AGENTS.md apps/analytics-api/AGENTS.md apps/backoffice-web/AGENTS.md packages/contracts/AGENTS.md packages/db-kds/AGENTS.md packages/auth/AGENTS.md ':(glob)apps/*/docs/**'
then
  echo "Found stale documentation references above."
  fail=1
fi

echo "Checking expected AGENTS.md coverage..."
for file in \
  AGENTS.md \
  apps/kds-api/AGENTS.md \
  apps/kds-web/AGENTS.md \
  apps/analytics-api/AGENTS.md \
  apps/backoffice-web/AGENTS.md \
  apps/crew-web/AGENTS.md \
  apps/legal-site/AGENTS.md \
  apps/marketing-site/AGENTS.md \
  apps/inventory-api/AGENTS.md \
  apps/crm-api/AGENTS.md \
  apps/notifications-api/AGENTS.md \
  packages/contracts/AGENTS.md \
  packages/db-kds/AGENTS.md \
  packages/db-auth/AGENTS.md \
  packages/db-crm/AGENTS.md \
  packages/db-notifications/AGENTS.md \
  packages/auth/AGENTS.md
do
  if [ ! -f "$file" ]; then
    echo "Missing expected instruction file: $file"
    fail=1
  fi
done

echo "Checking retired phase files stay deleted..."
for file in docs/phase-1-verification.log docs/phase-2-plan.md
do
  if [ -e "$file" ]; then
    echo "Retired phase file should stay deleted: $file"
    fail=1
  fi
done

echo "Checking Prisma model inventory (a new model must be registered so a new domain can't land silently — see ADR-0012)..."
# Every model in each Prisma schema must appear in the matching known_*_models
# list below. Adding a row forces an agent to consciously register the table AND
# document it (ARCHITECTURE.md, plus an ADR if it crosses a boundary — see
# ADR-0011 for the ai_* tables, ADR-0015 for the db-auth split). This guard is
# what would have caught the AI assistant tables landing undocumented.
known_kds_models="Tenant ProviderAppState PosAccount Location CloverMerchant KdsDeviceToken CloverOrder KdsTicket KdsTicketOverride KdsTicketItem KdsProviderConfig KdsTicketEvent KdsScreenSession KdsFilter CloverWebhookEvent KdsProviderEvent KdsRealtimeState KdsRealtimeEvent KdsRealtimeReceipt DeadLetterJob AiConversation AiMessage AiUsageEvent AiModelPriceCache AppSetting AppSettingAudit"
known_auth_models="WebAdminAccount WebAuthnCredential TenantMembership"
known_crm_models="CrmCustomer CrmLoyaltyAccount CrmPointsLedger CrmReward CrmRewardRedemption CrmReferral CrmDeadLetterJob"
known_notifications_models="Notification NotificationState NotificationPref NotificationCategoryPref NotificationActionAudit"
known_inventory_models="InventoryCategory InventoryItem InventoryItemCostHistory InventoryItemAlias InventoryItemImage InventoryItemPack InventoryBarcode InventoryItemState InventoryRecipe InventoryRecipeLine InventoryRecipeModifier InventoryVendor InventoryVendorQuote InventoryPurchaseOrder InventoryPoLine InventoryCountRecord InventoryWasteReason InventoryWasteEntry InventoryActivityEntry InventoryWasteSettings InventorySecuritySetting InventoryMetrics InventoryEmployee InventoryStockMovement InventoryReceiptScan InventoryLaborCost InventoryDepletionCursor"

check_schema_models() {
  schema_path=$1
  allowed=$2
  if [ ! -f "$schema_path" ]; then
    return
  fi
  for m in $(grep -E '^model [A-Za-z]' "$schema_path" | awk '{print $2}')
  do
    case " $allowed " in
      *" $m "*) : ;;
      *)
        echo "Unregistered Prisma model '$m' in $schema_path."
        echo "  -> Register it in scripts/check-doc-drift.sh AND document the table/domain in ARCHITECTURE.md (add an ADR if it crosses an Iron Law boundary, cf. ADR-0011 / ADR-0015)."
        fail=1
        ;;
    esac
  done
}

check_schema_models "packages/db-kds/prisma/schema.prisma" "$known_kds_models"
check_schema_models "packages/db-auth/prisma/schema.prisma" "$known_auth_models"
check_schema_models "packages/db-crm/prisma/schema.prisma" "$known_crm_models"
check_schema_models "packages/db-notifications/prisma/schema.prisma" "$known_notifications_models"
check_schema_models "packages/db-inventory/prisma/schema.prisma" "$known_inventory_models"

echo "Checking ADR numbering (ids are the PR number; no duplicates, no 0000 placeholders — see ADR-0037)..."
# (a) No committed 0000- placeholder: the PR is open, so the file must be renamed
#     from 0000- to the PR number (Rust-RFC style, ADR-0037).
for f in docs/decisions/0000-*.md
do
  [ -e "$f" ] || continue
  echo "ADR still carries the 0000 placeholder: $f"
  echo "  -> Rename 0000- to your PR number, update the '# ADR-<n>:' header + the README index (ADR-0037)."
  fail=1
done
# (b) No two ADRs share a number. Only the historical 0014 / 0018 / 0033 collisions
#     are grandfathered (immutable, see the README note + ADR-0037). New ADRs use
#     their PR number, which GitHub guarantees unique — so any new duplicate is a bug.
adr_nums=$(for f in docs/decisions/[0-9]*-*.md
do
  [ -e "$f" ] || continue
  b=$(basename "$f")
  echo "${b%%-*}"
done)
dup_nums=$(printf '%s\n' "$adr_nums" | sort | uniq -d | grep -vE '^(0014|0018|0033)$' || true)
if [ -n "$dup_nums" ]; then
  echo "Duplicate ADR number(s) — two ADRs share one id (only 0014/0018/0033 are grandfathered):"
  for n in $dup_nums
  do
    echo "  $n:"
    for g in docs/decisions/"$n"-*.md
    do
      [ -e "$g" ] && echo "    $g"
    done
  done
  echo "  -> ADR ids must be unique; new ADRs take their PR number (ADR-0037). Renumber the newer file."
  fail=1
fi

echo "Checking repo-relative markdown links..."
# Why: doc moves keep breaking inbound relative links (4 fixed in #506, 29 more
# found when this check landed). Existence-only by design — anchors are not
# validated. Intentional dead targets go in the script's ALLOWLIST.
if ! python3 scripts/check-doc-links.py; then
  fail=1
fi

echo "Documentation line counts (review anything that keeps growing past 300 lines):"
for file in README.md AGENTS.md HANDOFF.md docs/*.md
do
  [ -f "$file" ] || continue
  printf "%5s %s\n" "$(wc -l < "$file")" "$file"
done | sort -nr

echo "Checking dev-source resolution wiring (yr-src)..."
# Keeps the dev-only "resolve package SOURCE, not stale dist" wiring consistent
# across every consumer and provably out of prod (docs/LOCAL-DEV-GUIDE.md +
# config/yr-src-map.mjs; architecture-as-guardrails, ADR-0012). Four invariants:

# (a) Every @rop/* package declares yr-src on every export subpath, so the
#     frontend alias map (derived from exports in config/yr-src-map.mjs) is complete.
for pkg in contracts auth db-kds db-auth db-inventory db-crm db-notifications
do
  if node -e 'const e=require(`./packages/${process.argv[1]}/package.json`).exports||{};for(const k of Object.keys(e)){const c=e[k];if(!c||typeof c!=="object"||!("yr-src"in c)){console.error(`  packages/${process.argv[1]} export "${k}" is missing the yr-src condition`);process.exit(1)}}' "$pkg"
  then :; else fail=1; fi
done

# (b) Every tsx backend dev + dev:worker activates the Node condition.
for app in kds-api inventory-api analytics-api crm-api notifications-api
do
  for s in dev dev:worker
  do
    v=$(node -e 'const s=(require(`./apps/${process.argv[1]}/package.json`).scripts||{})[process.argv[2]]||"";process.stdout.write(s)' "$app" "$s")
    if [ -n "$v" ]; then
      case "$v" in
        *--conditions=yr-src*) : ;;
        *) echo "  apps/$app script \"$s\" is missing NODE_OPTIONS='--conditions=yr-src'"; fail=1 ;;
      esac
    fi
  done
done

# (c) Every Next frontend sets YR_SRC=1 in dev AND imports the shared alias map.
for app in backoffice-web kds-web crew-web order-web
do
  grep -q 'YR_SRC=1' "apps/$app/package.json" || { echo "  apps/$app dev script is missing YR_SRC=1"; fail=1; }
  grep -q 'yr-src-map' "apps/$app/next.config.ts" || { echo "  apps/$app/next.config.ts does not import config/yr-src-map"; fail=1; }
done

# (d) Prod-leak guard: the dev-only flags must never reach a prod surface.
if git grep -nE 'yr-src|YR_SRC' -- '*Dockerfile' 'compose/' >/dev/null 2>&1
then
  echo "  LEAK: a yr-src / YR_SRC token appears in a Dockerfile or compose file (must stay dev-only):"
  git grep -nE 'yr-src|YR_SRC' -- '*Dockerfile' 'compose/' || true
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "Documentation drift check failed."
  exit "$fail"
fi

echo "Documentation drift check passed."
