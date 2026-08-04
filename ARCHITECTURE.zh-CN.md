# Example Kitchen — 架构

> 🌐 [English](ARCHITECTURE.md) · **中文**
>
> 本文为英文版的人工同步镜像，可能滞后；两版不一致时**以英文版为准**。
> 最近审阅：2026-05-24

这份文档是 Example Kitchen 的"概念地图"：系统是什么、各组件怎么拼起来、有哪些不变量。**怎么部署**看 [`OPERATIONS.md`](OPERATIONS.md)。**为什么这么定**看 [`docs/decisions/`](docs/decisions/) 下的 ADR。**改代码时遵循的规则**看 [`AGENTS.md`](AGENTS.md)。

---

## 目录

1. [这是个什么系统](#1-这是个什么系统)
2. [Domain 和 surfaces](#2-domain-和-surfaces)
3. [五条铁律](#3-五条铁律)
4. [数据流](#4-数据流)
5. [认证模型](#5-认证模型)
6. [代码组织](#6-代码组织)
7. [运行时拓扑](#7-运行时拓扑)
8. [为什么是这个形状 — 决策记录](#8-为什么是这个形状--决策记录)

---

## 1. 这是个什么系统

Example Kitchen 是一套**餐厅软件套件**（单店起步，正演进为多家自营门店——一个品牌，见 [ADR-0018](docs/decisions/0018-multi-location-architecture.md)），运行于 **Clover** 与 **Square** POS 之上。它有三个产品面：

- **Floor**（厨房现场） — 厨房显示屏（iPad / TV / 浏览器）。实时订单 board、顾客取餐显示、厨房员工动作（fire、bump、hold）。每天运行 16 小时，在厨房噪音环境下操作；容错率低。
- **Backoffice**（后台） — 老板 / 经理仪表盘。销售分析、daypart 热力图、menu engineering、KDS 设备管理、Clover 集成设置。桌面+移动端，决策时长 UX（分钟级而不是秒级）。
- **Analytics pipeline**（数据流水线） — Clover → Postgres OLAP mart，**自己没有 UI**。Backoffice 通过 BFF 读取它。

**正在从单商户演进为多门店**（一个品牌、多家自营门店，由店主与合伙人共管——见 [ADR-0018](docs/decisions/0018-multi-location-architecture.md)）。这是多*门店*形态，**不是**多租户 SaaS：只有一个品牌，门店是它的子节点，跨店可见是特性而非泄露。一个 POS 无关的 `Location` 注册表现在位于 Clover `merchantId` 之上；KDS 与 analytics 仍按 `merchantId` 给业务行分区，品牌自有数据（库存）按 `locationId`。商户上下文来自 `clover_merchants` 表里每店一份的 Clover token；旁边新增了 `pos_accounts` 表（`PosAccount` 凭据实体），使非 Clover POS 可被接入——Clover 一账户对一门店，像 Square 这样的多门店 POS 一账户对多门店（见 [docs/square-onboarding.md](docs/square-onboarding.md)）。

部署是一台 Oracle ARM VM，每个 app 作为一个普通 `docker compose` stack，通过 SSH 部署。品牌的各门店的实时 POS 跑在门店自己的系统上（Clover、Square）；本仓的生产是 dev/staging 级部署，处理真实 POS 数据用于数据分析，但**不是**活动 POS。

---

## 2. Domain 和 surfaces

### 2.1 App

**核心** app 承载订单/分析/库存/忠诚度数据流；**卫星** app（前端、一个原型、两个静态站点）独立发布。

| App | 路径 | 技术栈 | 职责 |
|---|---|---|---|
| **kds-api** | [`apps/kds-api`](apps/kds-api) | Fastify + Prisma + Redis + BullMQ | Floor 后端 — Clover 摄取、ticket 状态、WebSocket fanout、KDS admin JSON API |
| **kds-web** | [`apps/kds-web`](apps/kds-web) | Next.js 16（自定义 CSS） | Floor 前端 — board、customer display、login。**没有 admin UI**（Phase 4 移到 Backoffice）。 |
| **analytics-api** | [`apps/analytics-api`](apps/analytics-api) | Node http + 原生 SQL + Luxon | OLAP 摄取 — Clover → mart，9 个 worker 子系统（scheduler、realtime、export、hydration、repair、dq、mart、webhook-inbox、http） |
| **backoffice-web** | [`apps/backoffice-web`](apps/backoffice-web) | Next.js 16 + Tailwind v4 + shadcn/ui | admin + analytics UI — 老板/经理仪表盘、KDS 管理、Clover 集成、库存，以及悬浮 **AI 助手**（Phase 7；写入 `ai_*` 表 — 见 [ADR-0011](docs/decisions/0011-ai-tables-bounded-exception.md)） |
| **crew-web** | [`apps/crew-web`](apps/crew-web) | Next.js 16 + Tailwind v4 + React 19 | 线厨库存 app（PIN 登录、waste / receive / 86 / recount）。**原型** — mock 数据，暂无后端 |
| **legal-site** | [`apps/legal-site`](apps/legal-site) | nginx 静态 HTML/CSS | Clover Marketplace 上架用的 EULA + 隐私 + 支持站 |
| **marketing-site** | [`apps/marketing-site`](apps/marketing-site) | nginx 静态 HTML/CSS/JS | 面向顾客的营销站 `www.example.com` |
| **inventory-api** | [`apps/inventory-api`](apps/inventory-api) | Fastify + Prisma（db-inventory） | 库存后端 — items / waste / counts / PO / vendors；同时服务 crew-web（Floor）与 backoffice-web |
| **crm-api** | [`apps/crm-api`](apps/crm-api) | Fastify + Prisma（db-crm） | 忠诚度/CRM 后端 — 客户、append-only 积分 ledger、奖励；POS 无关。见 [ADR-0021](docs/decisions/0021-loyalty-crm-domain.md) |
| **order-web** | [`apps/order-web`](apps/order-web) | Next.js 16 + Tailwind v4 | 面向顾客的在线点单（order-ahead / 取餐）。**原型** — mock 数据，暂无后端。见 [ADR-0025](docs/decisions/0025-online-ordering-architecture.md) |

### 2.2 共享包

| 包 | 路径 | 拥有什么 |
|---|---|---|
| **contracts** | [`packages/contracts`](packages/contracts) | 跨 app 边界的 Zod schema + TS 类型（kds-api ↔ kds-web ↔ backoffice-web ↔ iOS） |
| **db-kds** | [`packages/db-kds`](packages/db-kds) | KDS 业务表的 Prisma schema、迁移、生成的 client（tickets、orders、merchants、sync state） |
| **db-auth** | [`packages/db-auth`](packages/db-auth) | 鉴权表（`web_admin_accounts`、`web_authn_credentials`）的 Prisma schema、迁移、生成的 client。与 db-kds 同一个物理 Postgres，仅在 Prisma 包边界拆开，使 `packages/auth` 不依赖 `db-kds`。见 [ADR-0015](docs/decisions/0015-extract-auth-tables-into-db-auth-package.md)。 |
| **db-inventory** | [`packages/db-inventory`](packages/db-inventory) | 库存表（items、recipes、vendors、waste、counts、PO、append-only 的 `inventory_stock_movements` ledger、`inventory_depletion_cursor` 轮询水位）的 Prisma schema、迁移、生成的 client。独立 Postgres（`INVENTORY_DATABASE_URL`），仅被 inventory-api 消费。按 [ADR-0018](docs/decisions/0018-multi-location-architecture.md) 做 location 分区；销售驱动的扣减经 stock-movement ledger，见 [ADR-0028](docs/decisions/0028-sales-driven-inventory-depletion.md)。 |
| **db-crm** | [`packages/db-crm`](packages/db-crm) | 忠诚度/CRM 表（`crm_customers`、`crm_loyalty_accounts`、append-only 的 `crm_points_ledger`、`crm_rewards`、`crm_reward_redemptions`、`crm_referrals`）的 Prisma schema、迁移、生成的 client。独立 Postgres（`CRM_DATABASE_URL`），仅被 crm-api 消费。见 [ADR-0021](docs/decisions/0021-loyalty-crm-domain.md)。 |
| **auth** | [`packages/auth`](packages/auth) | Passkey（WebAuthn）+ Argon2id 密码 + cookie session，kds-api / kds-web / backoffice-web 共用 |

---

## 3. 五条铁律

这些是整个 suite 必须维持的不变量。违反任何一条都会造成代价高昂的架构漂移。规则原文见 [`AGENTS.md`](AGENTS.md)，**为什么**每条都存在见 [`docs/decisions/0002-five-iron-laws.md`](docs/decisions/0002-five-iron-laws.md)。

| # | 规则 | 为什么存在 |
|---|---|---|
| 1 | **Database 边界** — 每个 app 独占自己的 Postgres。不跨 app import DB client。 | 共享一份 schema 后迁移协调就崩了。backoffice-web 只读 KDS DB 是因为复用 auth 表 — 永远不动业务表。 |
| 2 | **Contract 边界** — 跨 app DTO 走 `packages/contracts` zod schema。不手写 DTO。 | 防止 kds-web / iOS / backoffice 的 DTO 副本在 kds-api 改时漂移。 |
| 3 | **Auth 边界** — passkey / cookie / session 逻辑住在 `packages/auth`。app 不重新实现。 | 三个 app 需要相同的 passkey 流。三份副本 = 三个细微不同的 bug。 |
| 4 | **Floor vs Backoffice** — `kds-web` 是 Floor（厨房 TV、board、display）；`backoffice-web` 是 admin（老板、经理）。**不要混**。 | UX 不同、刷新节奏不同、容错率不同。混在一个 surface 会两边都变差。 |
| 5 | **读不是写** — `analytics-api` 是只读 OLAP。它**永远**不写 KDS 的 DB。Backoffice 也不写两边。所有写都走原始服务。 | 双主状态机会发明出测试不抓的腐化模式。 |

---

## 4. 数据流

### 4.1 订单摄取（Clover → 我们）

```
                ┌──────────────┐
                │  Clover POS  │
                └──────┬───────┘
                       │  订单事件 webhook
                       ▼
         webhooks.example.com/clover    (Traefik dynamic config)
                       │
                       │  Traefik mirroring 服务
              ┌────────┴────────┐
              ▼                 ▼
         kds-api             analytics-api
         /clover/webhooks    /webhooks/clover
              │                 │
              ▼                 ▼
         realtime sync     webhook-inbox queue
         (Clover REST       (幂等、重试、
          backfill +         最终一致的
          ticket 状态)        OLAP mart 刷新)
              │                 │
              ▼                 ▼
         postgres-kds      postgres-analytics
         (OLTP)            (OLAP)
```

两个关键属性：

- **Webhook 通过 Traefik mirroring 扇出** — 一个 Clover POST 同时落到两个后端，互不影响。任一失败不影响另一边。见 [`infrastructure/traefik/dynamic/clover-webhook-fanout.yml`](infrastructure/traefik/dynamic/clover-webhook-fanout.yml) 和 `HANDOFF-clover-webhook-fanout.md`。
- **两个独立 DB 是设计** — KDS 优化在几千行上的亚秒级 ticket 更新；analytics 优化在数百万行上的多年聚合查询。schema 不同、index 不同、不变量不同。见 ADR-0001。

### 4.2 Floor 实时

```
kds-api  ──WebSocket /ws──►  kds-web board  (浏览器)
   │                          ┌──────────────────────────┐
   │                          │  /board /display /login  │
   │                          └──────────────────────────┘
   │
   └──WebSocket /ws──►  iOS YRBoard (原生)
                          ┌────────────────────────────┐
                          │  YRUI / YRRealtime / YRStore │
                          └────────────────────────────┘
```

两个 client 都消费同一个 `/ws?merchantId=...` 流。Board 的权威是 `kds-api` + `postgres-kds`；client 维护 outbox 保证动作最终到达服务器但能容忍短暂断网。

> ⚠️ 这条实时链路**默认云可达** —— 每一跳（Clover → kds-api → WebSocket → 屏幕）都走公网。Outbox 只覆盖*短暂*断线，无法在持续的 WAN/路由器中断下兜底（票到不了屏）。LAN 本地中继回退是 roadmap，尚未实现 —— 见 [ADR-0013](docs/decisions/0013-lan-fallback-roadmap.md)。

### 4.3 Backoffice analytics

```
浏览器  ──HTTPS──►  backoffice-web (Next.js)
                      │
                      │  /api/* BFF Route Handlers
                      │  Bearer auth + zod 校验
                      ▼
                  analytics-api /admin/api/*
                      │
                      ▼
                  postgres-analytics  (mart MV，~5min 刷新)
```

`backoffice-web` 是 `analytics-api` 前面的**纯 BFF**。浏览器永远不直接调 analytics-api。理由：
- 浏览器 session 是 cookie 的；analytics-api 只懂 bearer auth。
- BFF 把 analytics API shape 适配成 UI 形状的 JSON，隔离 UI 和内部 schema。
- BFF 能合并多个 analytics 调用（比如 `/api/today/insights` 并行调两个 analytics query）。

### 4.4 Backoffice ↔ KDS admin

```
浏览器  ──HTTPS──►  backoffice-web (admin 页面)
                      │
                      │  BFF /api/admin/kds/*
                      │  Bearer: KDS_INTERNAL_ADMIN_TOKEN
                      ▼
                  kds-api /api/admin/kds/*
```

Phase 4（见 docs/archive/HANDOFF-phase-closeouts.md）把所有 KDS admin 从 `kds-web` 移走（之前是 1490 行内联 HTML），搬到 Backoffice。`kds-api` 保留了 JSON 端点；HTML 渲染没了。边界推理见 ADR-0003。

---

## 5. 认证模型

### 5.1 浏览器 ↔ apps（Floor + Backoffice）

| Surface | 方法 | Cookie | RP ID |
|---|---|---|---|
| `kds.example.com`（Floor login + admin） | Passkey（WebAuthn）主，Argon2id 密码兜底 | `rop_session`（默认） | `kds.example.com` |
| `backoffice.example.com`（admin 壳） | 同上 | `rop_backoffice_session`（和 Floor 不同，避免 localhost 开发冲突） | `backoffice.example.com` |

两个 app 消费 `postgres-kds` 里**同一套** `WebAdminAccount` + `WebAuthnCredential` 表。从 Floor `/setup-passkey` 注册的用户能用同一个 passkey 登 Backoffice，**仅当**那个 passkey 注册时 `RP_ID = backoffice.example.com`（或用共享父域作为 `WEBAUTHN_RP_ID`）。

> ⚠️ **WebAuthn RP ID 在注册时绑死，不能迁移**。改 `WEBAUTHN_RP_ID` 会强制所有用户重新注册。

### 5.2 服务间

| 调用方 → 被调用方 | 方法 | Token env（两侧必须同值） |
|---|---|---|
| backoffice-web → kds-api `/api/admin/kds/*` | `Authorization: Bearer …` | `KDS_INTERNAL_ADMIN_TOKEN` |
| backoffice-web → analytics-api `/admin/api/*` | `Authorization: Bearer …` | `ANALYTICS_ADMIN_TOKEN`（等于 analytics-api 的 `ADMIN_TOKEN`） |

任一 token 在任一侧没设，请求返回 `503 admin_not_configured`（fail-closed）。两个 token 独立 — 轮换其中一个不影响另一个。

这些 bearer 故意是**简单共享 secret**，不是 JWT。信任模型：只有有宿主机访问权的运维（经 Infisical）能设；只有两个服务知道；年轮一次。这个规模不需要 expiry / refresh / 签名校验。trade-off 讨论见 ADR。

### 5.3 Webhook auth

| 端点 | 方法 |
|---|---|
| `/api/clover/webhooks`（kds-api） | 设 `CLOVER_WEBHOOK_AUTH_CODE` 后开启可选 Clover 签名头校验 |
| `/webhooks/clover`（analytics-api） | 同上 |

---

## 6. 代码组织

### 6.1 Monorepo 布局

```
restaurant-ops-platform/
├── apps/
│   ├── kds-api/             Fastify 后端（Floor 权威状态）
│   ├── kds-web/             Next.js Floor 前端
│   ├── analytics-api/       OLAP 摄取（无 UI）
│   └── backoffice-web/      Next.js admin 壳 + BFF
├── packages/
│   ├── contracts/           Zod DTO（跨 app source of truth）
│   ├── db-kds/              Prisma schema + 迁移 + client
│   └── auth/                Passkey + session 库
├── ios/                     Swift Package workspace（原生 KDS 客户端）
├── compose/         生产 `docker compose` stack（SSH 部署）
├── docker-compose*.yml      本地开发 + 可观测性栈
├── docs/
│   ├── decisions/           ADR（本文件的兄弟）
│   └── ...                  主题指南
├── scripts/                 build、deploy、sync、validation
└── infrastructure/
    ├── dokploy/             未来改进路线图
    └── traefik/             动态配置（webhook fan-out）
```

### 6.2 各 app 约定

每个 `apps/<name>/AGENTS.md` 声明该 app 的规则。常见模式：

- **kds-api**：provider 特定 payload 留在 backend adapter 后面。`src/lib/web-auth.ts` 是 `packages/auth/server` 的 shim。
- **kds-web**：保留自定义 CSS（厨房显示美学）；**不**导入 Backoffice 的 design token。两个产品刻意不视觉统一。
- **analytics-api**：自由 SQL 走 `src/analytics/safe-query.ts`（带白名单的参数化）。其他地方不允许原始 client SQL。
- **backoffice-web**：纯转换函数住在 `lib/<feature>/*-transform.ts`，注入时间锚点便于确定性测试。URL 状态在 `lib/<feature>/url-state.ts`。用 shadcn Charts（Recharts 包装），不是原始 Recharts。

### 6.3 BFF + transform 模式（Backoffice）

Phase 2-4 沉淀的模式：

```
app/api/today/route.ts                 ─► 调 analytics-api，用 zod 校验
lib/analytics-api/sales-transform.ts   ─► 纯函数把 API JSON 转成 UI 形状
hooks/use-today.ts                     ─► TanStack Query hook（staleTime: 60_000）
components/today/*.tsx                 ─► 消费 hook 的 UI 组件
```

transform 层是**唯一**知道 analytics-api 线上 shape 的东西。明天换上游 → 只改 transform 层。

---

## 7. 运行时拓扑

生产跑在一台 Oracle ARM VM 上，每个 app 是一个普通 `docker compose` stack，通过 SSH 部署。完整拓扑 — 网络、healthcheck、域名、镜像流 — 在 [`OPERATIONS.md` §1](OPERATIONS.md#1-system-topology)。简述：

| Stack | 容器 |
|---|---|
| `kds` | `migrate`、`kds-api`、`kds-worker × 2`、`kds-web` |
| `analytics` | `analytics-api` |
| `backoffice` | `backoffice-web` |
| （数据存储 — 普通 compose 服务、named volume、仅内网） | `postgres-kds`、`postgres-analytics`、`redis-kds` |
| （可观测性，独立 compose project） | Grafana、Prometheus、Loki、Promtail |

构建流：GitHub Actions 自托管 arm64 runner（在 Mac Mini 上）→ 多阶段 Docker 构建 → `ghcr.io/example-org/rop-<app>:main` → SSH 到 Oracle 主机 → `scripts/deploy-stack.sh <stack>`（git 同步后 `docker compose pull && up -d`）。运行时 secret 在容器启动时从 Infisical 注入（[ADR-0020](docs/decisions/0020-adopt-infisical-for-runtime-secrets.md)）。见 [`OPERATIONS.md` §3](OPERATIONS.md#3-cicd-pipeline)。

---

## 8. 为什么是这个形状 — 决策记录

每个承重形状背后的"为什么"在 [`docs/decisions/`](docs/decisions/)。下面这些时候读它们：
- 你想违反某条铁律但想知道会坏什么。
- 你想重构但想知道哪些约束是真的。
- 你接手了项目想跳过考古挖掘。

| ADR | 主题 |
|---|---|
| [0001](docs/decisions/0001-pnpm-monorepo-with-four-apps.md) | pnpm monorepo with 4 apps（vs polyrepo、vs 单 app） |
| [0002](docs/decisions/0002-five-iron-laws.md) | Five Iron Laws as boundary enforcement |
| [0003](docs/decisions/0003-floor-vs-backoffice-split.md) | Floor (kds-web) vs Backoffice (backoffice-web) split |
| [0004](docs/decisions/0004-static-clover-token-from-db.md) | Static Clover token from DB, OAuth optional |
| [0005](docs/decisions/0005-dokploy-over-coolify.md) | Dokploy v0.29 chosen over Coolify v4 |
| [0006](docs/decisions/0006-self-hosted-arm64-runner.md) | Self-hosted arm64 GHA runner on Oracle（被 0008 替代） |
| [0007](docs/decisions/0007-validate-compose-env-script.md) | `validate-compose-env.py` 防 env drift |
| [0008](docs/decisions/0008-cutover-arm64-runner-to-mac-mini.md) | arm64 GHA runner 从 Oracle 切到 Mac Mini |
| [0009](docs/decisions/0009-pipeline-optimization-followups.md) | 流水线优化待办（backlog） |
| [0010](docs/decisions/0010-heartbeat-on-mac-mini.md) | Mac Mini 上的心跳监控 |
| [0011](docs/decisions/0011-ai-tables-bounded-exception.md) | AI 助手表：DB 边界的受限例外 |
| [0012](docs/decisions/0012-architecture-as-guardrails.md) | 架构即护栏 —— AI agent 契约 |
| [0013](docs/decisions/0013-lan-fallback-roadmap.md) | 实时依赖云可达 —— LAN 回退 roadmap |
| [0014a](docs/decisions/0014-manual-deploy-trigger.md) | 手动触发部署（合并 ≠ 部署） |
| [0014b](docs/decisions/0014-sentry-saas-over-glitchtip.md) | app 侧错误追踪选 Sentry SaaS 而非自托管 GlitchTip |
| [0015](docs/decisions/0015-extract-auth-tables-into-db-auth-package.md) | 把鉴权表抽到 `packages/db-auth` |
| [0016](docs/decisions/0016-app-setting-table.md) | `app_setting` 表扩展 AI 受限例外（运行期配置存储） |
| [0017](docs/decisions/0017-deepseek-replaces-codex.md) | AI 助手用 DeepSeek 替换 Codex |
| [0018a](docs/decisions/0018-multi-location-architecture.md) | 多门店架构 —— `Location` 之于 `merchantId` |
| [0018b](docs/decisions/0018-tooling-selection-for-agent-dev.md) | AI agent 驱动开发的工具选型准则 |
| [0019](docs/decisions/0019-decouple-store-identity-from-clover.md) | 门店身份与 Clover 解耦 —— POS 无关的门店模型 |
| [0020](docs/decisions/0020-adopt-infisical-for-runtime-secrets.md) | 采用 Infisical 作为运行期 secret source |
| [0021](docs/decisions/0021-loyalty-crm-domain.md) | 引入 `packages/db-crm` + `apps/crm-api`（忠诚度/CRM domain） |
| [0022](docs/decisions/0022-loyalty-ledger-and-accrual.md) | 忠诚度 ledger 仅 append；积分发放事件驱动、幂等、单向 |
| [0023](docs/decisions/0023-loyalty-points-legal-posture.md) | 积分是无现金价值的促销（与礼品卡储值隔离） |
| [0024](docs/decisions/0024-membership-crm-customer-identity.md) | 会员/CRM —— 客户身份归 crm-api 一个 domain，按手机号 key |
| [0025](docs/decisions/0025-online-ordering-architecture.md) | 在线点单（order-web）架构与边界 |
| [0026](docs/decisions/0026-integration-tests-via-testcontainers.md) | 用 Testcontainers 做集成测试（拆 unit vs integration） |
| [0027](docs/decisions/0027-clover-online-payment-and-order-bridge.md) | Clover 在线支付（hosted iframe）+ Atomic-Order 桥接到 KDS |
| [0028](docs/decisions/0028-sales-driven-inventory-depletion.md) | 销售驱动的库存扣减，经 append-only stock-movement ledger |
| [0029](docs/decisions/0029-federated-rbac-and-auth-lifecycle.md) | 套件级 federated RBAC 角色 + auth 生命周期 |
| [0030](docs/decisions/0030-semantic-metric-registry-as-ai-grounding.md) | 受治理的 metric registry 作为 AI grounding 契约 |
| [0031](docs/decisions/0031-profitability-analytics-cost-dimension.md) | analytics-api 中以成本维度做盈利分析 |
| [0032](docs/decisions/0032-forecasting-compute-surface.md) | 独立的预测计算面，脱离只读 OLAP 路径 |
| [0033](docs/decisions/0033-labor-cost-as-effective-dated-reference.md) | 人力成本作为有效期参考维度（prime cost，Phase 4a） |
| [0033](docs/decisions/0033-verify-clover-webhook-hmac.md) | 校验 Clover webhook HMAC 签名（分阶段 fail-open → fail-closed） |
| [0034](docs/decisions/0034-clover-sync-dead-letter-queue.md) | 失败的 Clover 同步事件的死信队列 + 重放 API |
| [0035](docs/decisions/0035-analytics-read-dtos-into-contracts.md) | 把 analytics-api 的只读 DTO 收进 @rop/contracts |

新决策：复制 [`docs/decisions/README.md`](docs/decisions/README.md) 里的模板，递增编号，从这里加链接。

---

> 架构变了？改这个文件**并且**如果是承重变动加一份 ADR。英文版 [`ARCHITECTURE.md`](ARCHITECTURE.md) 应该在同一个 PR 里同步更新。
