# Example Kitchen — 多租户终态架构（Greenfield 设计）

> **Status:** current — greenfield 终态目标。本系统在本次重设计语境下**不视为已上线**：所有 nullable-then-backfill 接缝、所有 `off`/`observe`/`enforce` 三态模式、所有 `DEFAULT_TENANT_ID`/`DEFAULT_LOCATION_ID` 兜底，一律**删除而非迁移**。`tenant_id` 从第一条 migration 起即在每张租户表上 `NOT NULL`；设备配对是数据面设备获取 scope 的**唯一**途径；RLS `FORCE` 跑在**非 superuser 运行角色**上从首条 migration 起生效。只有一种模式：**enforce**。本文是规范终态——照此实现，不要再推导增量路径。本文取代 `docs/architecture/multi-tenant-architecture.md` 中任何阶段化描述，与 ADR-0818 一致（ADR-0818 取代 ADR-0018）。**诚实声明：尽管 mandate 视系统未上线，KDS 配对、inventory/crew、backoffice settings/AI、order-web 都有真实 prod 部署；§7 的 cutover runbook 显式列出它们各自需要的一次性物理重配/数据重置/双边密钥/行为变更，不假装它们是透明 code-only 重构。**

---

## 0. 现状对账（2026-06-23 grounding — 落地前必读）

本文 mandate 写作时设系统为"白纸"，但落地前的代码核查发现 **staged 多租户脚手架已于 2026-06-19/20 合并进 `main`**，因此本文的"delete not migrate / 首条 migration 即 NOT NULL"**不按字面照搬**，改以**前向迁移**抵达同一终态。

**已合并的脚手架（终态的严格前缀）：**
- db-kds：`model Tenant`、`enum TenantStatus`、`Location.tenantId`（nullable）；`tenant-default` 行经 `20260619_tenant_entity` seed。
- db-auth：`model TenantMembership`（`20260620_tenant_membership`，从既有 `WebAdminAccount` backfill）。
- `tenant_id` **nullable 列 + backfill 到 `'tenant-default'`**：db-kds / db-inventory / db-crm / analytics 全库（6+ 已合并迁移）。
- `packages/contracts`：`DEFAULT_TENANT_ID`、`TenantSchema`/`TenantScopeSchema`/`TenantMembershipSchema`/`TenantSessionClaimSchema`/`AnalyticsTenantClaimSchema` + sign/verify、**KDS 设备配对 DTO**（`KdsDeviceRoleSchema`/`KdsDevicePair*`）。
- 5 处 live `DEFAULT_TENANT_ID` fallback：`kds-auth.ts:241`、`device-pairing.ts:57`、`user.ts:67`、`session.ts:103`、`tenant-auth.ts:80`。

**裁定：前向迁移，不重写历史。** KDS 已部署到 prod，`migrate reset` = 丢数据且零收益；nullable 列已在、数据已对，终态 = 把它收紧（flip `NOT NULL` + RLS + 命名键 + crew 配对 + 统一原语 + 删 5 处 fallback）。终态形状与下文一字不差，仅到达方式从"reset"改为"forward ALTER"。

**对 Phase 0 的两点校正：**
1. **KDS 配对 DTO 已存在**（`packages/contracts/src/index.ts`）——Phase 0 的 contracts 工作只剩 crew 侧 + 通用 `DeviceClaim` 形状。
2. **`DEFAULT_TENANT_ID` 移出 barrel 不能在 Phase 0 做**——它有 5 个 live importer，须排在那 5 处 fallback 删除之后（≈ Phase 3–5），否则 `pnpm build` 当场挂。下文 §7 Phase 0 据此理解。

---

## 1. 终态架构总览

### 1.1 一段话论旨（thesis）

设备或人**从不声明**自己的租户——它**证明**一个租户，而那份证明是解锁 scope 的唯一钥匙。每个数据面设备（KDS、display、crew，order-web 除外）通过 `packages/auth` 里**唯一**的 `DeviceIdentity` 原语拿到自己的 `(tenantId, scopeKey, role)`；该原语只含逻辑（mint/hash/verify/cookie-options + claim mint/redeem），token **表**仍归各 app 自有 DB（Iron Law 1）。每个操作员通过登录时由 `TenantMembership` 签发的 `TenantSessionClaim` 拿到完整 `TenantScope`。**自治服务端写入者**（webhook ingest、reconciliation poller、loader/cron、DLQ replay）是第四类 principal——它们没有 session 也没有设备 token，从被处理事件携带的 `merchantId` 经 `merchantId → tenantId` 非空解析拿租户。每个请求/工作项都收敛到唯一的 `resolveStore(...) → {tenantId, locationId} | null`；`null` 永远是 `403`（或工作项 fail）。解析出的 `tenantId` 经 `forTenant(tenantId)` 包装器在一个事务内发 `SET LOCAL app.tenant_id`——而 **Postgres RLS FORCE** 跑在**非 superuser、非表 owner 的运行角色 `yr_app`** 上，使这道墙在 app 之下无法绕过。运行期没有 `DEFAULT_TENANT_ID`、没有 `DEFAULT_LOCATION_ID`、没有对 `?location=`/`?merchantId=` 的隐式信任。`provisionTenant` 把哪怕是 tenant #1 也物化成一行真实数据。

### 1.2 三个平面，一道墙

```
                       ┌──────────── tenant_id = 硬信任边界 (RLS FORCE on yr_app) ────────────┐
 CONTROL PLANE         │                                                                      │
 (操作员 session)       backoffice ── analytics ── inventory(经理面) ── crm ── notifications     │
   TenantSessionClaim ──┘    │           │            │            │            │              │
   {tenantId, locationIds}   forTenant(tenantId) 包住每次 DB 调用 ── RLS FORCE                  │
                                                                                              │
 DATA / DEVICE PLANE   kds-web ── kds-display ── crew-web ── order-web                          │
 (设备配对 token)           │           │            │           └─(从 Location 行取)            │
   DeviceIdentity ─────────┴───────────┴── yr_device_token ──┘                                  │
   {tenantId, scopeKey, role}                                                                   │
                                                                                              │
 SYSTEM / INGEST       webhook ingest ── reconciliation poller ── loader/cron ── DLQ replay     │
 (merchantId→tenantId)     └── 每工作项 forTenant(merchantId→tenantId) ── 绝不 DEFAULT 兜底 ──┘  │
                       └──────────────────────────────────────────────────────────────────────┘
```

- **Control plane**（backoffice-web / analytics-api / inventory-api 经理面 / crm-api / notifications-api）：操作员 session 绑定一个 **Tenant**，session 携带完整 `TenantScope`（`tenantId` + `locationIds`）。
- **Data/Device plane**（kds-web / display / crew-web / order-web / kds-api / inventory-api 楼面）：设备配对 token 绑定一个 **(Tenant, Location)** 对——**除 order-web** 这个唯一无设备公开面，它从 `Location` 行取 scope。
- **System/Ingest plane**（webhook、poller、loader、cron、worker、DLQ replay）：无 principal，从工作项的 `merchantId` 非空解析 `tenantId`，每工作项独立 `forTenant`。
- `tenant_id` 是硬信任边界；`merchantId`/`locationId` 是其下的分区键。

---

## 2. 数据模型（终态）

### 2.1 跨库唯一的命名键决策（先读这条）

**裁定：`Location.id` 是 `@default(cuid)`，全局唯一；"locationId 全局唯一"立为硬不变量。`tenant_id` 列加到每张租户表用于 RLS；只有真正会跨租户冲突的"人为/POS/固定 sentinel"键才把 `tenantId` 加进键里。**

针对本代码库的理由：任何已由 `locationId`（cuid）或 **POS 签发 id**（`merchantId`/`providerMerchantId`/Clover·Square order id）打头的复合键**已全局唯一**——两个租户永不共享同一 `locationId` 字符串。对这些键只加 `tenant_id` 列做 RLS 谓词，**键本身不动**——塞 `tenantId` 进本已全局唯一的键纯属索引膨胀 + 迁移风险，零安全收益。真正跨租户冲突的是**人为/身份/固定命名空间**：slug、短码、电话、PIN、SKU、vendor-alias、POS-item id、**以及一切 `id='singleton'`/`'default-merchant'` 之类的固定 sentinel PK**。这些——也只有这些——必须把 `tenantId` 加进唯一键。

**信任边界是 `tenant_id` 列 + RLS policy，不是键的形状。** 每库带一份机器可检的 **`GLOBAL_TABLES` 白名单**，让 `NOT NULL` 全扫不误碰无租户表，并由 `docs:check` 漂移守卫红掉任何新增的"既无 `tenant_id` 又不在白名单"的表（含每张全局表的 `yr_app` GRANT 必须显式、最小化）。

### 2.2 db-kds（`Tenant` 注册表归属库）— `packages/db-kds/prisma/schema.prisma`

| Model | 终态决策 |
|---|---|
| `Location` (:169) | `tenantId` **NOT NULL** + FK `onDelete: Restrict` + `@@index([tenantId])`；`slug @unique` → **`@@unique([tenantId, slug])`**（id 仍 cuid）。 |
| `CloverMerchant` (:197) | `tenantId` NOT NULL。PK `id`（POS merchant id）保持。保留 `locationId` partial-unique。`tenantId` 是 ingest 的 `merchantId→tenantId` 解析源（**非空，无兜底**）。 |
| `PosAccount` (:109) | `tenantId` NOT NULL。`@@unique([provider, providerMerchantId, environment])` 不动（POS 全局）。 |
| `KdsDeviceToken` (:262) | `tenantId` NOT NULL + FK + index；`tokenHash @unique` 保持。`scopeKey` = `merchantId`。**重构到 `DeviceIdentity` 原语**（§3）；verify 查询加 `tenantId` 谓词。**双 FK 删除语义裁定见 §2.8**。 |
| `CloverOrder` (:279) | `tenantId` NOT NULL。PK `id` = per-merchant POS order id → **`@@id([merchantId, id])`**。ingest upsert 写 `tenantId`（§3.7）。 |
| `KdsTicket` (:309) | `tenantId` NOT NULL。`cloverOrderId @unique` → **`@@unique([merchantId, cloverOrderId])`**；`@@unique([merchantId, provider, sourceOrderId])` 不动。ingest upsert 写 `tenantId`。 |
| `KdsProviderEvent` (:497) | `tenantId` NOT NULL。`fingerprint @unique` → **`@@unique([merchantId, fingerprint])`**。 |
| **`AppSetting` (:675)** | **db-kds 最高价值泄漏点。今天无 `tenantId` 列**。ADD `tenantId` NOT NULL。今 PK `@@id([merchantId, key])`，brand 级键 `merchantId` 默认魔法串 `"default-merchant"`，而 brand 行**装 AI provider 密钥**（`category=secret`）。终态 PK → **`@@id([tenantId, merchantId, key])`**，brand-scope sentinel 变**每租户**（`brandScopeId(tenantId)` = 该租户自身 id，绝不再用全局魔法串）。**deployed 读写路径必须同步重写**——见 §7 Phase 2.5 与 §8。 |
| `AppSettingAudit` (:704) | ADD `tenantId` NOT NULL；索引 → `@@index([tenantId, merchantId, key, changedAt])`。 |
| 其余运营模型 | `tenantId` NOT NULL + index：`KdsTicketOverride`、`KdsTicketItem`、`KdsProviderConfig`、`KdsTicketEvent`、`KdsScreenSession`、`KdsFilter`、`CloverWebhookEvent`、`KdsRealtimeState`、`KdsRealtimeEvent`、`KdsRealtimeReceipt`、`DeadLetterJob`、`AiConversation`、`AiMessage`、`AiUsageEvent`。 |

**`GLOBAL_TABLES`（无 `tenant_id`，不加 NOT NULL，无 RLS policy，`yr_app` 只读 GRANT）：** `Tenant`（注册表本身）；`ProviderAppState`（:85，共享 marketplace-app webhook 簿记，auth 层把关；`yr_app` 写权限**仅** GRANT 给 webhook-bookkeeping 代码路径，非 `GRANT ALL`）；`AiModelPriceCache`（:653，单行共享价目，`yr_app` 只读 + 刷新 cron 路径写）。

### 2.3 db-inventory（27 模型 + 员工）— `packages/db-inventory/prisma/schema.prisma`

不归属 `Tenant`（Iron Law 1）：每行裸带 `tenantId String` NOT NULL `@map("tenant_id")` + `@@index([tenantId])`，不跨库 FK。

真冲突键 → 加 `tenantId`：

| Model | 键变更 |
|---|---|
| `InventoryEmployee` (:527) | `pinLookup @unique` → **`@@unique([tenantId, pinLookup])`**。crew 登录查询（§4.2）必带 `tenantId`。 |
| `InventoryItem` (:28) | `sku @unique` → **`@@unique([tenantId, sku])`**。 |
| `InventoryItemAlias` (:205) | `@@unique([vendor, normalized])` → **`@@unique([tenantId, vendor, normalized])`**。 |
| `InventoryRecipe` (:268/:278) | `cloverItemId @unique` + `squareCatalogObjectId @unique` → **`@@unique([tenantId, cloverItemId])`** + **`@@unique([tenantId, squareCatalogObjectId])`**。 |
| **`InventoryBarcode`** | **已核实需加 `tenantId` 进键**：barcode/UPC 是全局自然键（Sam's/Walmart UPC），两租户必然进同一 UPC → 若 barcode 值 `@unique` 则 → **`@@unique([tenantId, value])`**。 |
| **`InventoryWasteSettings` / `InventoryMetrics` / `InventorySecuritySetting`** | **固定 `id='singleton'` PK——与 AppSetting 同类 sentinel 撞库**。PK → **`@@id([tenantId, id])`**（或 sentinel 变每租户）。`inventory-store.ts` 所有 `where:{id:'<literal>'}` 同步加 `tenantId`。 |

已 `locationId` 打头的键 → 只加列：`InventoryItemState @@id([locationId, itemId])` (:250)；`InventoryCountRecord`/`InventoryWasteEntry @@unique([locationId, idempotencyKey])` (:421/:456)；`InventoryStockMovement @@unique([locationId, reason, sourceRef, itemId])` (:565)；`InventoryReceiptScan @@unique([locationId, ref])` (:613)；`InventoryLaborCost @@id([locationId, effectiveFrom])` (:642)。`InventoryItemPack @@unique([itemId, vendor, label])` (:117)——`itemId` 全局 cuid，不动。

其余仅加列 NOT NULL：`InventoryCategory`、`InventoryItemCostHistory`（**核实其自然键**）、`InventoryItemImage`、`InventoryRecipeLine`、`InventoryRecipeModifier`、`InventoryVendor`、`InventoryVendorQuote`、`InventoryPurchaseOrder`、`InventoryPoLine`、`InventoryWasteReason`、`InventoryActivityEntry`、`InventoryDepletionCursor`。

**新表 `InventoryDeviceToken`**（crew 设备配对）：`tenantId` NOT NULL、`locationId`（crew 的 `scopeKey`）、`tokenHash @unique`、`role`、`label`、`lastUsedAt`、`revokedAt`，`@@index([tenantId, locationId])`，RLS `FORCE`。
**新表 `InventoryPairingClaim`**（crew claim store，§3.4）：`code`（PK）、`tenantId`、`locationId`、`role`、`label`、`expiresAt`。**此表是 RLS 例外**——redeem 者是**尚无租户**的设备，见 §3.4 + §8 的 SECURITY DEFINER 裁定，列入 `GLOBAL_TABLES` 豁免并注明理由。

### 2.4 db-crm（租户内 brand-global，跨租户硬墙）— `packages/db-crm/prisma/schema.prisma`

裸 `tenantId String` NOT NULL + index。

| Model | 键变更 |
|---|---|
| `CrmCustomer` (:70) | `phoneE164 @unique` → **`@@unique([tenantId, phoneE164])`**——**CRM 身份墙**。 |
| `CrmPointsLedger` (:116) | `@@unique([source, sourceId, type])` 是**幂等键** → **`@@unique([tenantId, source, sourceId, type])`**。若 tenant-blind，二号租户同 `(clover_order, sourceId)` 让积分 INSERT 撞成 NO-OP，**静默吞掉 B 的积分**——财务 bug。 |
| `CrmReward` (:143) | `slug @unique` → **`@@unique([tenantId, slug])`**。 |
| `CrmRewardRedemption` (:164) | `code @unique` → **`@@unique([tenantId, code])`**；`ledgerId @unique`（uuid）不动。 |
| `CrmLoyaltyAccount` (:89) | 仅加列。 |
| `CrmReferral` (:187)、`CrmDeadLetterJob` (:211) | 仅加列。**replay 路径须重建原租户 scope**（§4.5）。 |

### 2.5 db-notifications（**第 5 个租户库——原设计漏掉，补全**）— `packages/db-notifications/prisma/schema.prisma`

notifications-api 是已上线 app（ADR-0801，prod 部署），BFF-only + 共享内部 token（Iron Law 1：**无 `Tenant` FK，裸 `tenantId String`**）。每模型加 `tenantId` NOT NULL + index。backoffice BFF 从 `TenantSessionClaim` 在**每次 ingest/read** 盖 `tenantId`，notifications-api 按它过滤。

| Model | 键变更 |
|---|---|
| `Notification` (:62) | `dedupeKey @unique`（**生产者幂等键，全局——与 CrmPointsLedger 同类静默丢**：二号租户同 `dedupeKey` 撞进既有行 → B 的 86/recount 告警永不出现）→ **`@@unique([tenantId, dedupeKey])`**。`locationId`（:62, null=brand-global）保留。 |
| `NotificationActionAudit` (:133) | `idempotencyKey @unique`（全局）→ **`@@unique([tenantId, idempotencyKey])`**。 |
| `NotificationState` | `@@unique([notificationId, operatorId])` → **`@@unique([tenantId, notificationId, operatorId])`**。 |
| `NotificationPref` | PK `operatorId` → **`@@id([tenantId, operatorId])`**。 |
| `NotificationCategoryPref` | `@@unique([operatorId, category])` → **`@@unique([tenantId, operatorId, category])`**。 |

`yr_app_notifications` NOSUPERUSER 角色 + ENABLE/FORCE RLS + policy 从首条 migration（§2.7、§8）。

### 2.6 analytics-api（raw SQL，`tenant_id` 打头列）— `apps/analytics-api/sql/migrations/*.sql`

终态：`tenant_id text NOT NULL`，**每个 PK/unique 与每个 `WHERE` 的打头列**。**注意 analytics 不是 Prisma**——自有 SQL migration + `pg.Pool`（§5、§8 详述连接模型）。

- **raw.\***（PK `(merchant_id, <id>)` → **`(tenant_id, merchant_id, <id>)`**）：`clover_orders/payments/refunds/tenders/employees/order_types/exports(UNIQUE)`、`square_orders/payments/refunds`。
- **mart fact**（PK 打头 `tenant_id`；分区见 §2.6 末）：`fact_orders/order_line_items/payments/refunds/line_item_modifiers`。
- **mart dim**（打头 `tenant_id`）：`dim_employee/tender/order_type/item/labor_cost/actual_cogs`、`forecast_daily/forecast_backtest`。
- **`mart.dim_item_cost` — 最锋利陷阱。** PK `(clover_item_id, effective_from)` **既无 merchant_id 也无 tenant_id**（011 注释称成本"brand 级"）。跨租户为假——两租户同 Clover item `ABC123` 成本不同，`cost_daily_mv` 横向 join（012:35）无租户谓词 → B 毛利用 A 成本算。终态：**`tenant_id` 进 PK 且进 join 谓词**。
- **config.sync_targets**（存 per-store POS token）：单列 `merchant_id` PK → **`(tenant_id, merchant_id)`**，`tenant_id NOT NULL`。**这是 ingest 的租户解析源**：loader/poller 从此表读 `tenant_id`（按它正轮询的 merchant），盖到所有 raw/mart INSERT。
- **物化视图**——唯一索引必须**打头 `tenant_id`**（DROP/CREATE，SELECT 带 `tenant_id`）：`sales_daily/hourly_mv`、`item_sales_daily/hourly_mv`、`payment_method_daily_mv`、`employee_sales_daily_mv`、`cost_daily_mv`、`prime_cost_daily_mv`、`cost_variance_daily_mv`。**MV REFRESH 是跨租户全量重建**，无法在 per-tenant `SET LOCAL` 下跑——见 §8 的 refresh-role 裁定。
- **audit.\* — 易忘泄漏。** 加打头 `tenant_id NOT NULL` + RLS：`backfill_runs`、`backfill_windows(UNIQUE)`、`sync_jobs`、`sync_runs`、`sync_cursors`、`dirty_windows`、`reconciliation_results`、`data_quality_checks`、`recon_daily`、`sync_windows`、`webhook_inbox(UNIQUE dedupe_key → (tenant_id, dedupe_key))`、`webhook_verifications`、`ai_query_log`。
- **每个 INSERT 是要改的代码**（不止 schema）：`ingest/raw-repository.ts`（clover_orders/payments/refunds/dynamic raw）、`square-raw-repository.ts`、`forecast/run.ts`、`sync-targets/repository.ts`、约 13 个 audit writer——**每个 INSERT 的列表加 `tenant_id`，值来自 `sync_targets.tenant_id`（每 sync-window 每 merchant 解析一次）**。

**`GLOBAL_TABLES`（无 `tenant_id`）：** `mart.dim_calendar`、`audit.schema_migrations`、`audit.service_heartbeats`、`audit.refresh_state`、`meta.metric_definitions`。

**fact 分区裁定：** **保留今天的 `business_date` RANGE 分区**（保 time-pruning），靠 `tenant_id`-打头 PK + RLS 做隔离，**不**改成 tenant-打头分区——单租户部署下 tenant-打头分区会把 ~100% 行塞进一个分区、毁掉 `business_date` pruning。租户下线用 `WHERE tenant_id` 批删 + RLS-不可见，不靠 `DETACH PARTITION`（生命周期收益不抵 pruning 损失）。`business_date` 与 `tenant_id` 都进 fact PK/unique（分区键约束要求）。

### 2.7 db-auth — `packages/db-auth`

**显式分类（非遗忘）：** `WebAdminAccount` + `WebAuthnCredential` 是**跨租户身份**（一个账号经多 `TenantMembership` 属多租户），列入 `GLOBAL_TABLES`，**auth 层把关、不上 RLS**（同 `ProviderAppState`）；`TenantMembership` 是租户轴的 join 表。`resolveAccountTenantId` 回退 `DEFAULT_TENANT_ID`（`user.ts:67`）**删除**——无 membership = `deny/throw`（`provisionTenant` 保证 ≥1）。WebAuthn 凭证绑账号而非租户：多租户操作员一份 passkey 跨其所有 membership 用。

### 2.8 Tenant 生命周期（删除语义）

`Tenant` FK 加到各表用 `onDelete: Restrict`；但 `KdsDeviceToken` 今对 `CloverMerchant` 是 `onDelete: Cascade`（:272），与新 Tenant-`Restrict` FK 构成双 FK 语义。**裁定：Tenant 无物理硬删——只用 `TenantStatus` 的 `ARCHIVED`/`OFFBOARDING`（枚举已存在）+ RLS-过滤不可见。** 不存在对称的 `deprovisionTenant` 物理删（财务/审计数据必须留存）。这样既回避了跨 FK 链（`CloverMerchant→KdsTicket→KdsTicketItem` 全 Cascade）的不可控 blast radius，又让"下线"成为一次状态翻转。

---

## 3. 设备身份与配对

### 3.1 统一原语 vs 两个 app-local 模块——裁定：**现在就建统一原语**

采纳"一个 `packages/auth` 原语"，理由：逻辑已在 KDS 上线验证，正要复制进 crew——复制那刻就是该共享那刻；包内已有先例（`crew-pin.ts` 自洽无 db/redis，经子路径导出供 `inventory-api` 消费而不耦合 db-kds）；反方案（两 app-local 模块靠人保持忠实）是**更多**漂移面。

**但"逐字 lift"是假的三处，须显式处理（见下），所以这是带签名重构的采纳，不是机械搬运。**

### 3.2 `DeviceIdentity` 原语 — 新建 `packages/auth/src/server/device-identity.ts`，子路径 `@rop/auth/device`

纯逻辑 + 注入式小 store。**不含 Prisma client、不含具体 Redis client**（Iron Law 1）。

```ts
// @rop/auth/device  (只有逻辑 — 无 db，无具体 redis)

export type DeviceRole = string;                              // 原语视 role 为不透明（见 §3.6）

export type DeviceClaim = {
  tenantId: string;                                           // 永远非空
  scopeKey: string;                                           // merchantId(KDS/DISPLAY) | locationId(CREW) — 对原语不透明
  role: DeviceRole;
  label: string;
};

// 1. TOKEN — 从 kds-auth.ts 搬。sha256 无 pepper（256-bit 随机无低熵原像，区别于 6 位 PIN）。
export function mintDeviceToken(): { token: string; tokenHash: string };  // "yrkds_" + base64url(randomBytes(24))
export function hashDeviceToken(token: string): string;                   // sha256 hex
export function readDeviceToken(headers): string | null;                  // bearer ?? cookie 的纯读取（precedence 留在 app，见 §3.8）

// 2. COOKIE — 只取最小结构 arg，绝不要 AuthServiceConfig（见下）。
export const DEVICE_TOKEN_COOKIE_NAME = "yr_device_token";
export type DeviceCookieConfig = { appBaseUrl: string };      // kds/inventory 的 AppConfig 结构上满足之
export function getDeviceCookieOptions(cfg: DeviceCookieConfig, maxAgeSeconds): CookieOptions;

// 3. CLAIM STORE — 注入式，原子单次消费。
export interface DeviceClaimStore {
  put(key: string, json: string, ttlSeconds: number): Promise<void>;
  consume(key: string): Promise<string | null>;               // 原子 GETDEL 等价（防重放）
}
export function generateClaimCode(): string;                   // Crockford base32, XXXX-XXXX
export function claimStoreKey(prefix: string, code: string): string;
// mint 只回 code(+ttl)；pairUrl 由各 app 用自己的 base-url 拼（crew/kds 不同源）。
export async function mintPairingClaim(store, prefix, claim, ttl): Promise<{ code: string }>;
// redeem 回校验后的 claim + 一枚新铸 token/hash；APP 做 *.create（Iron Law 1）。
export async function redeemPairingClaim(store, prefix, code): Promise<{ claim: DeviceClaim; token; tokenHash } | null>;
```

**三处"非逐字 lift"显式裁定（critic 高危）：**
1. **cookie 配置形状**：kds 的 `getDeviceCookieOptions(config)` 读 kds-api `AppConfig.appBaseUrl`；`packages/auth` 的 `baseCookieOptions` 读更大的 `AuthServiceConfig`（webauthnRpId/webLoginPasswordHash…）。inventory-api 既不构造也**不该**构造 `AuthServiceConfig`。**裁定：原语 cookie helper 取最小 `DeviceCookieConfig = { appBaseUrl }`（或裸 `secure: boolean`），不复用 `baseCookieOptions`——只在这一处重新实现 secure 推导。** 两边 AppConfig 结构上满足 `DeviceCookieConfig`。
2. **`pairUrl` 拼接**：`device-pairing.ts:74` 读 `services.config.kdsWebBaseUrl`——per-app 关切（crew pair URL 是另一源）。**裁定：`mintPairingClaim` 只回 code+ttl，各 app 用自己 config 拼 pairUrl**——URL 模板不进共享原语。
3. **bearer-vs-cookie precedence**：今 `authenticateKdsRequest` 在 session-cookie 短路**之后**才 `bearer ?? cookie`（kds-auth.ts:117）。**裁定：原语只暴露 `readDeviceToken(headers)→string|null` + `hashDeviceToken`；`authenticateKdsRequest` 保留其 session-first 短路与自有 `findFirst` 不变，precedence 留在 app**（一处可审）。

**`(tenantId, scopeKey, role)` 形状**：`scopeKey` 解耦——KDS 存 `merchantId`，crew 存 `locationId`，**原语永不解释**。**留在 app-local（Iron Law 1）：** 各库 token **表**；**每个** Prisma 调用；具体 claim store；`merchantId→tenantId` 解析（db-kds `cloverMerchant` 查找）及其 crew 类比。原语收到**已解析的非空** `tenantId`。

### 3.3 各数据面设备如何拿到 `(tenant, location)`

| 面 | 取 scope 方式 | 终态规则 |
|---|---|---|
| **KDS 板** (`kds-web`，同源) | 配对 `yr_device_token`（Traefik 同源 cookie）→ `authenticateKdsRequest` → token 绑定 `(tenantId, merchantId)`。 | `resolveKdsMerchantId` 唯一路径；不匹配 `?merchantId=` 403。**删** `resolveLegacyKdsMerchantId` + off/observe + `MULTITENANT_MODE`。 |
| **顾客屏** (`kds-web /display`) | 配对 DISPLAY `yr_device_token`，HTTP 与 `/ws/display` 升级都带。 | `resolveDisplayMerchant` 仅 enforce；**无公开 `?merchantId=` kiosk**；未配对 401，不匹配 403。 |
| **Crew** (`crew-web`，跨源) | crew 设备配对到 `(tenant, location)` → token 进 `InventoryDeviceToken`；crew-web BFF 在**自身源**重设 cookie（§3.5）；加每位厨师 PIN session（§4.2）。 | 设备证明 `(tenant, location)`，PIN 证明*是谁*；写需两者。 |
| **Order** (`order-web`，无设备) | **无设备**。Scope 来自 **`Location` 行**：`resolveOrderStore` 读 `Location.tenantId`；下单盖该租户。 | 唯一非设备 scope 面。**删 `resolveDefaultCloverMerchantId` 无-`?location=` 兜底**（§3.6）；location 不明/未绑/失活 → `null` → 无订单。 |

### 3.4 crew claim-store 后端 + RLS 例外裁定

`inventory-api` 无 Redis/BullMQ。**裁定：crew `DeviceClaimStore` 用 db-inventory 的短 TTL `InventoryPairingClaim` 表**，`consume` = `DELETE … WHERE code=$1 AND expires_at>now() RETURNING`（原子单次 + 过期过滤）；**外加** opportunistic/cron `DELETE WHERE expires_at<=now()` 清弃单（Postgres 行**不自过期**——这是必须 own 的维护，不能省）。

**RLS 例外（critic 高危——否则配对永不可能完成）：** `InventoryPairingClaim` 在 RLS FORCE 下，redeem 者是**尚无租户**的设备（`app.tenant_id` 未设 → USING 排除该行 → redeem 返回零行 → 配对死锁）。**裁定：redeem 走 `SECURITY DEFINER` 函数 `redeem_pairing_claim(code)`**，以提权身份按 code（不可猜的 capability）无租户谓词查删，返回 `tenant_id` 给调用方；`InventoryPairingClaim` 列入 `GLOBAL_TABLES` 豁免并注明理由。KDS 的 Redis claim 无 RLS 问题。

### 3.5 crew-web BFF 的 cookie 故事（crew-web 源 ≠ inventory-api 源）+ BFF 信任模型

KDS 能用因 `kds-web`/`kds-api` 同源。**`crew.example.com` ≠ 内网 inventory-api**——同源 cookie 把戏不转移。故意两个 cookie：

1. 经理在 backoffice 配对 crew iPad → 铸 claim（码/QR）。
2. crew 设备**经 crew-web BFF** redeem：BFF 调 inventory-api redeem 端点拿设备 token，在 **crew-web 自身源**设 `yr_device_token`（HttpOnly，原语 cookie 选项），如今天 PIN 登录在自身源设 `yr_crew_session`（`route.ts:37`）。
3. 之后每次 crew 写：crew-web BFF（`lib/server/inventory-api.ts`）把设备 token 与 PIN session **都**作 cookie header 转发给 inventory-api。crew-web 保持**仅持不透明 token**——**不得** import `@rop/auth`（保留 `CREW_COOKIE` 本地常量）。

**BFF-forwarded 写的信任模型（critic 高危）：** 转发是 server-to-server，**浏览器同源 cookie + Origin/Referer 保护不适用**于该转发调用。故 inventory-api 对 BFF-internal 流量：(1) 写守卫的生产 Origin/Referer 检查**跳过/替换**（server-to-server 无浏览器 Origin）；(2) 改为依赖**共享内部 service token**（如 `NOTIFICATIONS_INTERNAL_TOKEN` 模式）**加** per-device token——单一泄漏的 device token 从公网暴露路径也不能写；(3) 设备 token 在**每次转发写**都按 `(tenant, scope)` 校验（不止登录时）；(4) crew-web 自身 `/api/crew/*` 在转发**前**强制浏览器 same-origin。

### 3.6 Role 枚举——不搞一个 mega-enum

**裁定（critic 中危，改原设计）：** 原语视 `role` 为**不透明 string**（同 `scopeKey`），**不**建一个跨三库锁步的 `DeviceRole(KDS,DISPLAY,CREW)` mega-enum。各 app 的 db 枚举只约束**自己**的合法 role：db-kds `KdsDeviceRole = KDS|DISPLAY`；db-inventory 新 `InventoryDeviceRole = CREW`。role 合法性在 app 边界对 app-specific allowlist 校验。contracts 暴露的是 `DeviceRoleSchema`（宽 enum 仅供 DTO 形状），但**不**强令两个 db 枚举持相同成员集——一个 `CREW` 行落进 db-kds 即"可表示但非法"，正是要避免的 authz footgun。**若要守卫，须写真实跨枚举漂移检查脚本**（断言 contracts ∪ == db-kds ∪ db-inventory 各自约束）——`check-doc-drift.sh` 今天**不**做此检查，不要假称它做。

### 3.7 System/Ingest 写入者如何拿租户（**原设计漏掉，补全**）

webhook ingest + reconciliation poller 是 KDS/order 行的**主要**创建路径，funnel 经 `syncNormalizedOrder`（`sync-order.ts:419`）。其 `cloverOrder.upsert`（:453）与 `kdsTicket.upsert`（:487）今盖 `merchantId` 不盖 `tenantId` → `tenant_id NOT NULL` 下**首个 webhook 即运行期失败**。这些路径无 session 无设备 token。**裁定：第四类 principal「system/ingest writer」**——从事件的 `merchantId` 经 `resolveTenantIdForMerchant`（即今 `device-pairing.ts:57` 的查找，但**删其 `DEFAULT_TENANT_ID` 兜底**）解析**非空** `tenantId`；无租户的 merchant **硬失败 ingest，不兜底**；upsert 在 `forTenant(tenantId).run(...)` 内跑，写 `tenantId`。loyalty/fulfillment 回写 enqueue（`sync-order.ts:199-280`）的 BullMQ payload **必须携带 `tenantId`**，worker（及接收端 crm-api）据它设 RLS scope。

### 3.8 KDS admin 设备-create 的全部三处 call site

`DeviceIdentity` 重构必须覆盖**全部** `createDeviceToken`+`kdsDeviceToken.create` 点，否则它们漂移：pairing redeem、session-gated `admin.ts:162-201`、adminBearer `admin.ts:277-311`。撤销谓词同理于 `(tenantId, scopeKey, id)`——id-only 跨租户撤销 bug（`admin.ts:330-340`、:213；crew-admin `crew-admin.ts:85-132`）消亡。

---

## 4. 信任边界与三道闸

```
 PRINCIPAL                       第一道：RESOLVE              第二道：null→403           第三道：RLS
 ─────────                       ─────────────              ──────────────             ──────────
 operator → TenantSessionClaim ┐
 crew PIN → CrewSessionPayload ┤
 device   → DeviceClaim        ┤→ resolveStore(...)       →  {tenantId,locationId}  →  forTenant(tenantId)
 order    → Location.tenantId  ┤   (租户永远来自 principal/    | null ──► 403           = SET LOCAL app.tenant_id
 ingest   → merchantId→tenantId┘    ingest 解析,绝不来自 client)   (ingest:fail work)    在事务内（yr_app 连接）
                                                                                        │
                                                                                        ▼
                                                                                 Postgres RLS FORCE
                                                                                 (yr_app: NOSUPERUSER
                                                                                  NOBYPASSRLS, 非 owner)
                                                                                 跨租户 = 零行
```

**只有 enforce 一种模式。** 三个面上现存 `off`/`observe`/`enforce` 全删。

### 4.1 操作员 session（control plane）——卸 cruft，携完整 scope

`WebSessionRecord`/`View` 已带 `tenantId`；`createSession` 盖它。**三删一升：**
1. **删** `readSession` 把缺失 `tenantId` heal 成 `DEFAULT_TENANT_ID`（`session.ts:103`）：无 `tenantId` 记录**无效 → `null`**（强制重登），绝不 heal。
2. **删** `resolveAccountTenantId` 无 membership 回退 `DEFAULT_TENANT_ID`（`user.ts:67`）：缺 membership = `deny/throw`。
3. **升级** session view 从扁平 `tenantId` 串到完整 `TenantSessionClaim`（contracts `tenant.ts:82-87` = `{accountId, role, scope:{tenantId, locationIds}}`）：`createSession` 解析 membership → `TenantScope` 盖整个 scope；空 `locationIds` = 该租户全店（Toast 组语义）；无访问是 claim *缺失*，非 present-but-empty。backoffice BFF 消费 `session.scope`。

### 4.2 crew PIN session（data plane）——最高风险接缝 + 强制 ordering

`CrewSessionPayload = {employeeId, name, exp}`（`crew-pin.ts:29-34`）无 tenant/location；`resolveActor`（`crew-auth.ts:45-65`）从 DB 重导 `locationId` 不返回 `tenantId`；`pinLookup` 全局唯一。终态：
- **`CrewSessionPayload` 增 `tenantId` + `locationId`**，登录时从员工行盖。**类型留在 `crew-pin.ts`（type-only，零运行期依赖）**——不把 zod-backed contracts 类型作其源（crew-pin 刻意 node:crypto-only；crew-web 视 token 为不透明从不 parse → Iron Law 2 不要求它进 contracts）。
- **`pinLookup` 查询带 `tenantId`** 且键 `@@unique([tenantId, pinLookup])`。**bootstrap + 强制 ordering（critic 中危）：** PIN 登录端点跑在已配对 crew 源，设备 token 供 `tenantId`/`locationId`；**PIN-login 路由必须有 preHandler 硬要求有效 device token**：先从 device token 解析 `(tenantId, locationId)`，**无则 401**，**仅然后**跑 `WHERE tenantId=<device.tenantId> AND pinLookup=<hash>`。ordering 编进代码（preHandler）非散文；集成测试断言"无 device cookie → 401，绝不 tenant-blind 查找"。**这意味着无配对设备的浏览器无法 PIN 登录**——是相对今天 prod 行为的**有意 floor-ops 变更**（§7 cutover 显式列出）。
- `resolveActor` 直接从签名 crew payload 返回 `{id, name, tenantId, locationId}`——租户不再 DB 重导。crew token 仍自洽 HMAC（inventory-api 不 import db-kds/db-auth）。
- **`RateLimiter`（`crew-auth.ts`）的 key 须含 `tenantId`**——今为 in-memory 单进程、per-(IP,PIN) 且 tenant-blind；多租户多进程下一租户探测会 throttle 另一租户的厨师。

### 4.3 store-derivation 兜底点 → 一个 `resolveStore`（覆盖**读和写**）

把 `locationFor`（`inventory.ts:48-54`，`DEFAULT_LOCATION_ID`）、`laborCostLocationFor`（`labor-cost.ts:12-13`）、`admin-crew.ts:46`、**`actual-cogs.ts:13`（第 4 个，原设计漏）** 折成**唯一** `resolveStore(request): {tenantId, locationId} | null`。租户来自 principal——绝不来自 client；`null → 403`；无 `DEFAULT_LOCATION_ID`、无 env 默认。

**关键（critic 中危）：`resolveStore` 是读和写的单一入口。** `inventory.ts` 的 `locationFor` 被约 20 处调用（读 *和* 写：`:165/:193/:214/:283/:309/:640/:666/:709/:745/:783/:812/:858/:920/:935/:1014`），不止写守卫 preHandler——开放 READ 路由（GET dataset、plate-costs、receipt-scans、depletion-poll）也必须经 `resolveStore` 且在 `forTenant` 内跑，否则跨租户读返回他人数据。

### 4.4 analytics 签名 claim——往返已建，删闸门

`AnalyticsTenantClaim` + `sign/verifyAnalyticsTenantClaim`（server-only 子路径 `@rop/contracts/tenant-claim`，HMAC，刻意在 contracts 而非 auth，使 analytics-api 不拖 argon2/db-auth）已接线：backoffice 从 `session.scope.tenantId` 铸，挂 `x-tenant-claim`；analytics-api `enforceTenantScope` 核 claim 且用**自己**的 `config.sync_targets.tenant_id` 校验所请求 `merchant_id` 属该租户（绝不信 caller 列表）。**三删：**
1. `MULTITENANT_MODE` off/observe 闸（`tenant-auth.ts` `evaluate()`）→ 仅 enforce；缺/无效 claim = 401，跨租户 merchant = 403。
2. **未配 key 的 503 `tenant_claim_unconfigured` 分支删**——key 设为**必需 boot env**，缺 key = 启动失败（非每请求 503，非优雅 off）。
3. `NULL tenant_id → DEFAULT_TENANT_ID` heal（`tenant-auth.ts:80`）→ `sync_targets.tenant_id NOT NULL`。

**key 轮换 + 时钟偏移（critic 低危但 enforce-only 关键）：** 60s claim TTL + 单共享 key + enforce-only → 时钟偏移直接 401。**裁定：verify 端加几分钟 leeway + 双 key（current+previous）验证窗**，使 `ANALYTICS_TENANT_SIGNING_KEY` 可轮换不致 analytics 全停。

终态查询形状：每个 mart/raw/audit/MV 查询与 free-form `safe-query.ts` 都在 `withTenant()` 内跑 `WHERE tenant_id=$1 AND merchant_id=ANY($2)`；loader 每行盖 `tenant_id`。**框架反转（critic 高危）：RLS 是首要且唯一可信边界；`merchant_id` 过滤是查询塑形便利、非安全控制**——"SQL 已过滤 merchant 所以安全"正是墙腐烂之路。

**删四面每个 `DEFAULT_TENANT_ID` heal**（`session.ts:103`、`user.ts:67`、`device-pairing.ts:57`、`tenant-auth.ts:80`，及 kds-auth 任何 merchant-belongs heal），每处都是 fail-open。

### 4.5 System/Ingest + worker + DLQ 的租户 scope（**原设计仅一句，补全**）

无 HTTP 请求的自治写入者**每个**须 `SET LOCAL` 它正处理的租户：
- **kds-api reconciliation/poll worker**（per-merchant）：每工作项 `merchantId→tenantId` 后 `forTenant` 跑 ticket/override/state 写 + AppSetting 密钥读写 + WS fanout 读。
- **crm-api points-ledger accrual**（财务幂等路径）：accrual 写在 `forTenant(tenantId)` 内（tenantId 随 BullMQ payload 来）。
- **inventory crons**：`sync-sales-cron`、`runDepletionPoll`（`inventory-store.ts:1702`）、`syncRecipesFromClover/Square`——每 store/merchant 工作项 `forTenant`。
- **analytics sweep/scheduler/loader**：每 sync-window 从 `sync_targets.tenant_id` 解析后 `withTenant` 跑 ingest 事务（RLS FORCE 也挡 loader 自己的 INSERT——所以 ingest 事务也必须 `SET LOCAL`）。
- **AI price-refresh cron**：写 `AiModelPriceCache`（全局表，`yr_app` 该路径 GRANT 写）——无租户，但以 `yr_app` 连。
- **DLQ / CrmDeadLetterJob replay**：replay 重执行一次写——**必须重建原工作项的租户 scope**（从 dead-letter 行存的 `tenantId`/`merchantId`），否则以 replay runner 的（无）scope 写。dead-letter 行因此须存够还原 `tenantId` 的字段。

---

## 5. `forTenant()` ——唯一执行收口

**关键现实（critic 高危）：`forTenant().run()` 包 `prisma.$transaction` **不是** drop-in**，是 inventory-store 模块级签名重构：
- `getDataset()`（`inventory-store.ts:505-565`）是约 15 个 `findMany` 的 `Promise.all`，**在任何事务之外**。包进外层 `$transaction` 会强制 14+ 读在一个交互事务上**串行**（Prisma 交互事务单连接顺序执行）——board-load 热路径的真实延迟/锁回归。
- `receiveAdHoc` 等已开**自己的** `$transaction`（:305/:354/:592/:721/:851/:985/:1112/:1422）；外套 forTenant `$transaction` 会**嵌套**（Prisma 拒绝交互事务嵌套）。

**裁定：`forTenant` 返回用于*开启*事务的 client；inventory-store 各函数改签名收 `Prisma.TransactionClient`（不再内部自开 `$transaction`）。** `getDataset` 转成单个 `forTenant` 事务（接受其内 reads 串行 + 宽 timeout，这是 RLS-correct 的最简形；`$extends` query-hook 在 pooled 连接上不套事务则无效，会塌回同方案）。**显式 own 此成本并 benchmark `getDataset`——无零成本选项。**

```ts
// 每个 app 一个，落在自己的 Prisma client（不跨 app import db — Iron Law 1）
export function forTenant(prisma: PrismaClient, tenantId: string) {
  if (!tenantId || !tenantId.trim()) throw new Error("forTenant: empty tenantId");   // fail-closed
  return {
    run<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
      return prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;  // 参数化，事务级
        return fn(tx);
      });
    }
  };
}
```

**`forTenant` 的 tenantId 守卫（critic 高危）：** `set_config('app.tenant_id','',true)` 静默接受空串（`tenant_id=''` 偶然匹配零行——侥幸安全），但传 `DEFAULT_TENANT_ID`（= tenant #1 seed 值）会让调用方无 membership 证明读写 tenant #1。**故 `forTenant` 必须**：拒空/空白/undefined（抛错 fail-closed）；只接受来自已验证 principal 的 tenantId。`DEFAULT_TENANT_ID` 改为 **seed-script-local 字面量**（或 `SEED_TENANT_SLUG`，移出 runtime barrel export），加 eslint `no-restricted-imports` 禁其在 seed/provision 脚本外被 import。

- **inventory 落点：** 每 store 变更经 `inventory-store.ts`（约 10 个取 `locationId` 点含 `actual-cogs-store.ts:118`）；写守卫解析 `(tenantId, locationId)`，每个 `receiveAdHoc/count/waste/toggle86` 与 `getDataset()`/COGS/plate-cost **读** 都在 `forTenant(tenantId).run(...)` 内。跨租户读**返回零行，非 500**。
- **analytics 落点（critic 高危——pg.Pool 不是 Prisma）：** `withTenant()` **net-new 构造**（今天不存在）。`pg.Pool` 的 bare `pool.query()` 会从池取**任意空闲连接**——`SET LOCAL` 只绑一个 checked-out 连接一个事务，故 `withTenant` 后的 `pool.query` 跑在**另一个无 `app.tenant_id` 的 backend** 上。**裁定：`withTenant` 必须 `client = await pool.connect(); BEGIN; SELECT set_config('app.tenant_id',$1,true); … COMMIT; client.release()`，body 全部查询跑在该 checked-out client 上（复用 `db.ts:55` 的 `withTransaction(pool, task)` 为唯一入口）。约 25 个 `pool.query` 调用点（`src/analytics/*` + `safe-query.ts:61` + `tenant-auth.ts:68`）+ loader + cron 全须迁到 checked-out client。包装 pool 使唯一导出 query 入口要求租户 scope；`withTenant` body 首行断言 `current_setting('app.tenant_id',true)` 非空非空串否则抛。加 lint/grep 守卫禁 tenant scope 内裸 `pool.query`。**未落地此重写前，analytics 的 RLS 是戏。**

---

## 6. packages/auth + contracts 的接缝

### 6.1 `packages/contracts`（Iron Law 2）

**已存在：** `TenantSchema`/`TenantStatusSchema`/`TenantScopeSchema`/`TenantMembershipSchema`/`TenantSessionClaimSchema`/`AnalyticsTenantClaimSchema`、`sign/verifyAnalyticsTenantClaim`、`KdsDeviceRoleSchema` + 配对 DTO。
**新增/改：**
1. **`DeviceClaimSchema`** = `{tenantId, scopeKey, role, label}`。
2. **`DevicePairCreate {scopeKey, label, role}` + `DevicePairRedeem {code}` + `DevicePairResult {deviceId, scopeKey, role}`**（**不含明文 token**——见 §8 redeem-cookie-only）。
3. **`DeviceRoleSchema`** 宽 enum 仅供 DTO 形状（**不**强令 db 枚举锁步，§3.6）。
4. **不**把 `CrewSessionPayload` 移进 contracts（§4.2：crew-pin 零依赖、无跨 app DTO 消费 → 留 type-only 于 crew-pin.ts）。
5. BFF 消费 `TenantSessionClaim`，不再读扁平 `session.tenantId`。

`DEFAULT_TENANT_ID` 移出 runtime barrel，仅 seed 脚本本地可用。

### 6.2 `packages/auth`（Iron Law 3）

- **新 `device-identity.ts`** + `@rop/auth/device`（§3.2）——零 db/具体 redis。
- `session.ts` 携解析后 `TenantScope`；`service.createSession` 解析 membership → scope。
- `crew-pin.ts` 的 `CrewSessionPayload` 增 `tenantId + locationId`（type-only）。
- cookie helper 取最小 `DeviceCookieConfig`，**不**复用 `baseCookieOptions`（§3.2）。

### 6.3 Iron Law 1（DB 边界）——原语如何遵守

`device-identity.ts` **零 Prisma**；各 app token 表留自库、调用点供 `*.create/findFirst` 回调。`inventory-api` 永不 import `db-kds`；`analytics-api` import 无依赖的 `@rop/contracts/tenant-claim` 但**不** import `@rop/auth`。

---

## 7. 构建顺序（Greenfield PR 序列）+ cutover runbook

每 PR 令树绿（`pnpm lint && build && test && docs:check`，触 DB/migration 加 `test:integration`）。无可逆性表演、无 dual-read。父 Issue + 子 Issue。

**Phase 0 — contracts + 供给。**
1. `packages/contracts`：加 `DeviceClaimSchema`、`DevicePair*`、`DeviceRoleSchema`(宽)、`DEFAULT_TENANT_ID` 移出 barrel。
2. `provisionTenant` saga：物化 `Tenant` + 默认 `Location` + owner 的 `TenantMembership` + seed 每租户 `AppSetting` brand 行（`brandScopeId(tenantId)`）+ seed `config.sync_targets`。**tenant #1 也走它**。**裁定（critic 低危）：tenant #1 的 `Tenant.id` 固定为字面 `'tenant-default'`**——使各库 greenfield seed 一致；因系统全量 reset+reseed（无存量 backfill 行存活），此选择与"provisionTenant 物化真实行"不矛盾。

**Phase 1 — schema：每库一个 PR：`NOT NULL` + 命名键 + RLS 角色 + 连接拆分。** 每库 PR：(a) 每租户表 `tenant_id NOT NULL`，(b) 重命名真冲突键（§2，含 singleton/barcode），(c) **raw-SQL migration（以 owner/superuser 跑——它 BYPASS RLS 是预期）**建 `yr_app` `CREATE ROLE … NOSUPERUSER NOBYPASSRLS NOCREATEROLE` + 最小 DML `GRANT` + **`ALTER DEFAULT PRIVILEGES`（未来表自动 grant）** + `ENABLE`/`FORCE` RLS + `tenant_isolation` policy，(d) 全局白名单表不上 policy、`yr_app` 显式最小 GRANT（`ProviderAppState` 写仅限 webhook 路径），(e) **拆双 URL**：migrate service 保 owner URL，app/worker service 用新 `*_RUNTIME_DATABASE_URL`（认证为 `yr_app`），(f) **boot guard**：连接角色 `SELECT rolsuper OR rolbypassrls` 为真则拒绝启动。顺序：**db-kds**（owns `Tenant`）→ **db-inventory**（+ `InventoryDeviceToken` + `InventoryPairingClaim` + SECURITY DEFINER redeem）→ **db-crm** → **db-notifications** → **analytics**（raw → mart dim/fact → `dim_item_cost` PK+join → audit.\* → MV DROP/CREATE + loader 盖 `tenant_id`）。**四 + 一库各自需 `yr_app` 角色 + 双 URL；Infisical/host env 供四个 runtime 角色凭据。**

**Phase 2 — `DeviceIdentity` 原语 + KDS 重构（全三 call site）。** 建原语 + 子路径（最小 `DeviceCookieConfig`、`readDeviceToken`、code-only mint）。`kds-auth.ts`/`device-pairing.ts`/admin 三处 create 重构其上；`authenticateKdsRequest` `findFirst` 加 `tenantId`，precedence 留 app。删 `resolveTenantIdForMerchant` 兜底、KDS `MULTITENANT_MODE` off/observe。

**Phase 2.5 — backoffice settings/AI carve-out 重写（deployed-behavior 变更）。** 重写 `lib/settings/db.ts` + `lib/settings/tenancy.ts`（`BRAND_SCOPE_ID` 解析器）+ `lib/ai/deepseek-provider.ts`：threadtenantId 进 scope 解析，全局 `'default-merchant'` sentinel → `brandScopeId(tenantId)`。seed migration `20260528_seed_ai_deepseek_api_key` 改为经 `provisionTenant` 每租户 re-seed。**需 backoffice redeploy**；prod 现存 AI-key/加密密钥行须 re-key 到 provisioned tenant（reset 语境下重新供给，不原地迁移）。

**Phase 3 — 操作员 session 携完整 scope；删 heal。** `service.createSession` 解析 membership → 完整 `TenantSessionClaim`；删 `readSession` heal、`resolveAccountTenantId` 兜底；BFF 消费 `session.scope`。

**Phase 4 — crew 设备配对 + 带租户 PIN + ingest 写入者。** inventory-api：`InventoryDeviceToken` 经原语 create/verify（Postgres claim store + SECURITY DEFINER redeem）；`CrewSessionPayload` 增 `tenantId+locationId`，preHandler 强制 device-before-PIN；`resolveActor` 返回它们；PIN 查带 `tenantId`；`RateLimiter` key 含 `tenantId`。crew-web BFF：redeem 中继 + 自身源设 `yr_device_token` + 写时转发（内部 service token + per-device token 信任模型）。三+1 兜底折成 `resolveStore`（读+写约 20 点 + actual-cogs）。`forTenant` 签名重构覆盖全 store；**kds-api/crm-api/inventory 的 ingest/worker/cron/DLQ replay 全部 `forTenant` 落点**（§4.5）。

**Phase 5 — analytics 仅 enforce + `withTenant` 重写。** 建 `withTenant`（checked-out client）；约 25 `pool.query` + loader + cron 迁入；删模式闸、503-unconfigured、`tenant_id` heal；INSERT 列加 `tenant_id`（值来自 `sync_targets`）；MV DROP/CREATE 带 `tenant_id`；MV REFRESH/recon 走 refresh-role（§8）；`ANALYTICS_TENANT_SIGNING_KEY` 必需 boot env + 双 key 验证窗 + 两侧 Infisical 供给。

**Phase 6 — order-web 盖租户。** `resolveOrderStore` 读 `Location.tenantId`、**删 `resolveDefaultCloverMerchantId` 无-`?location=` 兜底**、要求每订单显式 location；order-web build 传显式 location（不靠 baked `NEXT_PUBLIC_CLOVER_MERCHANT_ID`），marketing-site deep-link 带 location。**整条 order-build 读+写链**（menu/price/hosted-checkout line items/ticket create，落在 kds-api `routes/order.ts`）在**一个** `forTenant(location.tenantId)` 内跑；集成测试断言 `?location=<tenantB>` 只读 B 的菜单且永不引用 A 的 item id。

**Phase 7 — db-notifications + 全局漂移守卫 + tenant #2。** notifications BFF 每 ingest/read 盖 `tenantId`；加 `GLOBAL_TABLES` 漂移检查（新无-`tenant_id`-非白名单表 red 构建 + 每全局表显式 GRANT 断言）+ 跨枚举漂移检查（若保留 `DeviceRoleSchema` 守卫）。供给真实 tenant #2 = enforce-everywhere 验证。

### 7.1 Cutover runbook（**显式列出非 code-only 的物理/数据/密钥/行为变更**）

- **非生产数据一次性 reset+reseed：** 每表从首条 migration `tenant_id NOT NULL` + 键重命名 → 本地/dev/prod 数据**不可原地迁移**。各库 PR 隐含 `prisma migrate reset`（analytics drop+rebuild）后 `provisionTenant("tenant-default")` reseed。`make dev-up` 顺序：migrate(owner) → provisionTenant → seed(yr_app)，吸收重置。
- **物理重配每台已部署 KDS/display iPad：** KdsDeviceToken `tenantId` 转 NOT NULL + 键 reshape → **现存 prod token 行不存活**。token 形状/cookie 字母表逐字保留**与行存活无关**——必须走到每台 iPad 开 `/pair` 重新 redeem 一枚新 claim。列为 cutover 运维步（每设备短暂 downtime）。
- **crew floor-ops 行为变更：** 今 prod 任意浏览器可 PIN 登录；终态 PIN 登录**硬要求预配对 device token** → 每台 crew iPad/手机须经理预配对方可首次 PIN。
- **order-web 客户 URL 契约变更：** 裸 `order.example.com` 无 location 不再静默服务 default store → 须 404/redirect；marketing deep-link 须带 location。
- **analytics 双边密钥 + 重部署：** 删 off-mode 短路**前**，先在 Infisical prod 为 backoffice + analytics-api 供匹配 `ANALYTICS_TENANT_SIGNING_KEY` 并重部署两者，否则 analytics 全黑；60s TTL 配 NTP/skew 容忍 + 双 key 窗。复用 `AI_PRICES_REFRESH_TOKEN` 双边供给 playbook。
- **backoffice settings/AI re-key + 重部署：** Phase 2.5 的 sentinel/PK 变更须 backoffice redeploy + AI-key 行 per-tenant 重新供给（丢失 = 丢 live AI provider 配置）。

---

## 8. 关键陷阱（终态版）

- **RLS owner-role / FORCE 陷阱（墙变真的核心）。** RLS 对**表 owner 与任何 superuser 静默绕过**，即便 `ENABLE`。每库**首条** migration 必做：(1) `ENABLE` **且** `FORCE ROW LEVEL SECURITY`（`FORCE` 让 policy 也作用于 owner）；(2) 专用**非 superuser、非 owner** 运行角色 `yr_app`（`NOSUPERUSER NOBYPASSRLS NOCREATEROLE`）+ 最小 DML GRANT + **`ALTER DEFAULT PRIVILEGES`（未来表自动授权——否则忘 GRANT 一张新表 = 该表对全 app 返回零行，静默 outage）**。migration 以 owner/superuser 跑（豁免，符合预期），**app/worker 进程绝不以 owner 连**。**今 inventory-api 运行期 DB 用户就是 migration superuser——必拆双 URL（owner-migrate / yr_app-runtime）+ boot guard 拒 superuser/bypassrls 运行角色，否则 RLS 形同虚设。同一拆分对 db-kds/db-crm/db-notifications/analytics 全部成立——含 kds-worker/analytics-scheduler/depletion-cron 这些独立进程，它们也以 `yr_app` 连并 `SET LOCAL`。**
- **policy 形状：** `CREATE POLICY tenant_isolation ON <t> USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));`。`WITH CHECK` 挡跨租户写入。`current_setting(…, true)` 未设返回 `NULL` → **没 `SET LOCAL` 的查询见零行**，正确 fail-closed。
- **`SET LOCAL` 连接绑定——两种连接模型分别裁定。** inventory-api/kds-api/crm-api 直连 Postgres（`compose/` 无 PgBouncer）→ 事务级 `set_config(…,true)` 绑到跑它的 backend，安全；**保持直连**。analytics-api 用 **`pg.Pool`**——**bare `pool.query` 是 `SET LOCAL` 的 no-op**（取任意空闲连接）→ `withTenant` 必须 `pool.connect()`+`BEGIN`+`set_config`+在该 client 上跑 body+`COMMIT`+`release`（§5）。若将来引入连接池到 Prisma 服务，**必须**事务池模式且 set_config 留 `$transaction` 内，绝不 session 池模式。**set_config 值参数化**（`$executeRaw` 模板 / `$1`），绝不字符串拼接。
- **MV REFRESH / recon / loader 的跨租户必要性（§9 "无旁路"的唯一受控例外）。** `REFRESH MATERIALIZED VIEW` 跨全租户重建，**无法**在 per-tenant `SET LOCAL` 下跑。**裁定：MV-refresh/recon 走一个文档化的、受限的 refresh 角色**（要么 MV 拥有者刷新身份，要么一个 `BYPASSRLS` 仅授予 refresh 路径的专用角色），显式记为 §9 "无可信旁路"原则的**唯一具名例外**且仅限 MV/recon 重建路径——不给请求服务或 ingest 写入者。loader 的 per-row INSERT 仍走 `yr_app` + `SET LOCAL`（非此例外）。
- **完整 `tenant_id` 覆盖（不漏一表）。** 最易漏：analytics 约 13 张 audit.\*、`mart.dim_item_cost`、**整个 db-notifications 库**、db-inventory 的 singleton-PK 三表、`InventoryBarcode`。对策：`GLOBAL_TABLES` 白名单漂移检查——新租户表无 `tenant_id` 且不在白名单则 red。漏一张 = 静默跨租户泄漏。
- **设备 cookie 的 CSRF + BFF server-to-server。** `yr_device_token` HttpOnly 随同源请求自动带 → 写守卫保留生产 Origin/Referer 白名单。**crew 跨源由 BFF 转发 token header（非浏览器自动 cookie）→ 不在 CSRF 自动携带面**：inventory-api 对 BFF-internal 流量跳过浏览器-Origin 检查、改用**内部 service token + per-device token**双因子，crew-web 自身 `/api/crew/*` 转发前强制 same-origin（§3.5）。
- **redeem 仅设 cookie，绝不回明文 token 给前端。** redeem 把 token 设进 HttpOnly cookie（KDS 同源；crew 由 BFF 在自身源设），**不**在响应体返回明文（无 `?token=`、无 localStorage）→ 关在 XSS 取不到处，且使原子单次 GETDEL/`DELETE RETURNING` 成真正"配一次"。`DevicePairResult` DTO 不含 token 字段。
- **client-readable store-hint cookie。** kds-web 的第二 cookie `yr_device_merchant`（非 HttpOnly，供 board RSC 客户端 scope）**绝不携带 `tenantId`**（租户是信任边界）——只放服务端会重新校验的不透明 `scopeKey`；服务端**从不信**它做 scope，永远从 HttpOnly token 重导。
- **Iron-Law 边界。** 原语零 Prisma；token 表归各库；`inventory-api` 不 import `db-kds`/`db-auth`；`analytics-api` 不 import `@rop/auth`；跨 app DTO 全走 contracts。违任一条被 `eslint no-restricted-imports` red。

---

## 9. 明确保持简单的取舍

- **到处加 `tenant_id` 列，只在真冲突处重命名键**（含 singleton/barcode/sentinel）。全局唯一 cuid `locationId` 让约 80% 复合键免费 tenant-safe，RLS 做隔离。*信任边界是列 + policy，重命名本已全局唯一的键只换索引膨胀 + 迁移风险。*
- **一个 `DeviceIdentity` 原语，不是共享设备 token 表。** 共享*逻辑*，表归各库。*反方案是更多漂移面。* 但承认三处非逐字 lift（cookie 形状 / pairUrl / precedence），按签名重构做。
- **Postgres 支撑 crew claim store，不给 inventory-api 加 Redis**——`DELETE … WHERE expires_at>now() RETURNING` 原子单次 + cron 清弃单 + SECURITY DEFINER redeem（pre-tenant 例外）。
- **inventory/kds/crm 直连（无 PgBouncer），analytics 用 pool 但 `withTenant` 走 checked-out client。** *错模式 PgBouncer 是经典 RLS 泄漏陷阱；bare `pool.query` 是 `SET LOCAL` no-op——两者都显式回避。*
- **crew 两个 cookie，BFF 在自身源设；inventory-api 信任 BFF 靠内部 service token + per-device token。** *crew-web ≠ inventory-api 源是事实。*
- **两 hash 函数分离**（设备 token sha256 无 pepper，PIN HMAC pepper）。*保护不同东西。*
- **order-web 从 `Location` 取 scope，不配设备，但删掉 no-location default-merchant 兜底。** *公开手机无设备可配；但兜底正是 mandate 禁的 default cruft。*
- **fact 表按 `business_date` RANGE 分区（非 tenant-打头），靠 tenant-打头 PK + RLS 隔离。** *tenant-打头分区在单租户下毁 time-pruning；下线用 `WHERE tenant_id` 批删 + RLS 不可见。*
- **物化视图携 `tenant_id` 并 DROP/CREATE，用 tenant-打头唯一索引；REFRESH 走文档化 refresh 角色。** *per-tenant 增量刷新不值当；REFRESH 跨租户是 §9 唯一具名例外。*
- **Tenant 无物理硬删，只 `ARCHIVED`/`OFFBOARDING` 状态 + RLS 不可见。** *财务/审计须留存；回避跨 FK Cascade blast radius。*
- **db-auth 的 `WebAdminAccount`/`WebAuthnCredential` 是跨租户身份（GLOBAL_TABLES，auth 层把关非 RLS）；`TenantMembership` 是租户轴。** *账号经 membership 属多租户，passkey 绑账号不绑租户。*
- **`role` 在原语不透明，各 app db 枚举只约束自己合法 role，不建跨库 mega-enum。** *mega-enum 让 `CREW` 行可落进 db-kds = 可表示但非法的 authz footgun。*
- **无"可信系统旁路"，唯一例外是具名的 MV-refresh/recon 角色。** loader/cron/worker/ingest 以 `yr_app` 连并 `SET LOCAL` 它正处理的租户；到租户数据只有一条设了租户的代码路径。

---

## 评审已消化的关键修正

**遗忘的整库/表（漏一张即跨租户泄漏）：**
- **db-notifications 整库**（第 5 个租户库，原设计完全漏）——`Notification.dedupeKey`（全局生产者幂等键 → 静默丢 B 的告警）、`NotificationActionAudit.idempotencyKey`、`NotificationState`/`NotificationPref`/`NotificationCategoryPref` 全加 `tenantId` 进键；`yr_app_notifications` 角色 + RLS。
- **db-inventory `InventoryWasteSettings`/`InventoryMetrics`/`InventorySecuritySetting`**——`id='singleton'` 固定 PK，与 AppSetting 同类 sentinel 撞库 → `@@id([tenantId, id])`。
- **`InventoryBarcode`**——UPC 全局自然键，两租户必撞 → `@@unique([tenantId, value])`。
- **`actual-cogs.ts`**——第 4 个 store-derivation/读路由（原设计只列 3）；`inventory.ts` 约 20 个 `locationFor` 读+写点（原设计只列 9 个写函数）。
- **analytics 约 25 个 INSERT 点 + 约 13 张 audit.\* + `mart.dim_item_cost`**——每个 INSERT 列加 `tenant_id`（值来自 `sync_targets`），非仅 schema。

**高危架构修正：**
- **analytics `pg.Pool` 的 `pool.query` 使 `SET LOCAL` 成 no-op**——`withTenant` 必须 net-new 构造为 `pool.connect()`+`BEGIN`+`set_config`+checked-out client，约 25 调用点全迁；裸 `pool.query` 在 tenant scope 内被 lint 禁。
- **`yr_app` 非 superuser/非 owner 角色 + 双 URL 拆分从未接线**——每库（4+1）首条 migration `CREATE ROLE … NOSUPERUSER NOBYPASSRLS` + `ALTER DEFAULT PRIVILEGES` + owner-migrate/yr_app-runtime 双 URL + boot guard 拒 superuser 运行角色；含 kds-worker/analytics-scheduler/cron 独立进程。
- **`forTenant().run()` 不是 drop-in**——inventory-store 模块级签名重构（函数收 `TransactionClient`，`getDataset` 转单事务串行 reads），显式 own 延迟成本 + benchmark。
- **`forTenant` 信任其 string 参数 + `DEFAULT_TENANT_ID` 仍 runtime-importable**——`forTenant` 拒空/空白、只收已验证 principal 的 tenantId；`DEFAULT_TENANT_ID` 移出 barrel + eslint 禁 import。
- **RLS 框架反转**——RLS 是首要且唯一可信边界，`merchant_id` SQL 过滤是塑形便利非安全控制（原设计称其"首要守卫、RLS 后盾"是墙腐烂之路）。
- **System/Ingest 写入者无租户故事**——webhook upsert（`sync-order.ts:453/:487`）、reconciliation poller、BullMQ 回写 payload、loader/cron、DLQ/CrmDeadLetterJob replay：第四类 principal，`merchantId→tenantId` 非空解析、每工作项 `forTenant`、replay 重建原 scope。
- **`InventoryPairingClaim` 在 RLS FORCE 下 redeem 死锁**（redeem 者尚无租户）——SECURITY DEFINER `redeem_pairing_claim(code)` + 列入 GLOBAL_TABLES 豁免 + cron 清弃单。
- **PIN-login 的 device-before-PIN ordering**——preHandler 硬要求有效 device token 供 `tenantId` 才查 `pinLookup`，否则 401（编进代码非散文）；`RateLimiter` key 含 `tenantId`。
- **BFF server-to-server 信任模型**——inventory-api 对 crew-web BFF 转发写跳过浏览器-Origin、改用内部 service token + per-device token 双因子，每次转发写校验设备 `(tenant,scope)`。
- **MV REFRESH 无法 per-tenant `SET LOCAL`**——文档化受限 refresh 角色作 §9 唯一具名跨租户例外，仅限 MV/recon 重建。
- **三处"非逐字 lift"**（cookie 配置形状须最小 `DeviceCookieConfig` 不要 `AuthServiceConfig`；`pairUrl` 各 app 自拼；bearer/cookie precedence 留 app）+ **KDS admin 全三处 device-create call site** 都须覆盖。
- **deployed prod cutover 诚实**——KDS/display iPad 物理重配对、crew 预配对方可 PIN、order-web URL 契约变更、analytics 双边密钥、backoffice settings/AI re-key + 各自重部署，全列入 §7.1 runbook（非透明 code-only）。

**中危（折入未单列）：** fact 表保 `business_date` RANGE 分区（非 tenant-打头）；db-auth 显式分类为 GLOBAL_TABLES；Tenant 无物理硬删只状态翻转 + 解决 KdsDeviceToken 双 FK；`DeviceRole` 不建跨库 mega-enum（原语不透明 + app-local 枚举）；`CrewSessionPayload` 留 crew-pin.ts type-only 不进 contracts；`InventoryPairingClaim` 过期 cron 清扫；analytics 60s claim 双 key + skew leeway；tenant #1 固定 id `'tenant-default'`。

文档路径：本设计为交付给实现 agent 的规范终态；落地参考路径与行号见原始设计的"实现者参考路径"小节（均为 repo 相对路径），新增覆盖：`packages/db-notifications/prisma/schema.prisma`、`apps/notifications-api/src/`、`apps/inventory-api/src/routes/actual-cogs.ts`、`apps/inventory-api/src/lib/actual-cogs-store.ts:118`、`apps/kds-api/src/lib/sync-order.ts:419,453,487,199-280`、`apps/kds-api/src/lib/order-store.ts:62,119`、`apps/kds-api/src/routes/order.ts`、`apps/analytics-api/src/db.ts:20-37,55`、`apps/analytics-api/src/ingest/raw-repository.ts`、`apps/analytics-api/src/ingest/square-raw-repository.ts`、`apps/backoffice-web/lib/settings/db.ts`、`apps/backoffice-web/lib/settings/tenancy.ts:14`、`apps/backoffice-web/lib/ai/deepseek-provider.ts:51-58`。