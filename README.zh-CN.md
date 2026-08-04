# Example Kitchen

> [English](README.md) · 中文
>
> 本文为英文版的人工同步镜像，可能滞后；两版不一致时**以英文版为准**。

**Example Kitchen** 是一个品牌的餐厅软件套件（基于 Clover + Square POS）—— 当前为单店，正演进为同一品牌下的多家自营门店（见 [ADR-0018](docs/decisions/0018-multi-location-architecture.md)）：厨房显示系统、顾客取餐屏、店主/经理分析后台、库存管理、前厅备料 App、原生 iOS KDS，以及随 Clover App Market 上架一起部署的营销和法律静态站。

仓库起点是一个孤立的 KDS 服务，如今已围绕该品牌的多家门店（Clover + Square POS）拓展到 **三个产品面**：

- **Floor（前厅 / 后厨）** — 厨房显示屏、顾客取餐屏、备料 App（web + iPad + iOS 原生）
- **Backoffice（后台）** — 店主/经理用的分析仪表盘、时段热力图、菜单工程、KDS 管理、Clover 配置、AI 助手
- **Analytics Pipeline（数据管道）** — Clover -> Postgres OLAP 物化视图，无 UI，只读

整个项目是一个 pnpm + Turborepo 单体仓库，部署到单台 Oracle ARM 云主机：每个 app 作为一个独立的 `docker compose` stack，通过 SSH 推送上线。生产环境跑的是真实 POS 数据的分析管线；各门店的实时 POS 跑在门店自己的餐厅系统上。

> 系统概念图：**[`ARCHITECTURE.md`](ARCHITECTURE.md)**（[中文](ARCHITECTURE.zh-CN.md)）
> 生产运维 / 日常 ops：**[`OPERATIONS.md`](OPERATIONS.md)**（[中文](OPERATIONS.zh-CN.md)）
> AI agent 和人类改代码的规则：**[`AGENTS.md`](AGENTS.md)**

---

## Apps（应用）

共 10 个 app，分为 **core**（核心数据流：订单 / 分析 / 库存 / 忠诚度）与 **satellite**（一个原型 + 在线点单 + 两个静态站 + iOS 原生客户端）两类。

### Core 核心 apps

| App | 路径 | 技术栈 | 生产 URL | 角色 |
|---|---|---|---|---|
| **kds-api** | [`apps/kds-api`](apps/kds-api) | Fastify + Prisma + Redis + BullMQ | `kds.example.com/api` | Floor 后端 — Clover 数据接入、ticket 状态、WebSocket 推送、KDS 管理 JSON API、登录 + Passkey |
| **kds-web** | [`apps/kds-web`](apps/kds-web) | Next.js 16（手写 CSS） | `kds.example.com` | Floor 前端 — 看板、顾客取餐屏、登录页。管理 UI 已迁出到 Backoffice。 |
| **analytics-api** | [`apps/analytics-api`](apps/analytics-api) | Node http + 原生 SQL（`pg`）+ Luxon + zod | `analytics.example.com` | OLAP 管道 — Clover -> mart，包含 9 个子系统（scheduler / realtime / export / hydration / repair / dq / mart / webhook-inbox / http）。架构上严格只读。 |
| **backoffice-web** | [`apps/backoffice-web`](apps/backoffice-web) | Next.js 16 + Tailwind v4 + shadcn/ui + TanStack Query | `backoffice.example.com` | 店主/经理后台 — 数据仪表盘、KDS 管理、Clover 配置、库存、AI 助手、运行期配置 |
| **inventory-api** | [`apps/inventory-api`](apps/inventory-api) | Fastify + Prisma（`db-inventory`） | 内网 | 库存数据持久化 — items / 配方 / 供应商 / 采购单 / 盘点 / 损耗。是 `crew-web`（前厅）与 `backoffice-web`（经理）共用的唯一写入入口 |
| **crm-api** | [`apps/crm-api`](apps/crm-api) | Fastify + Prisma（`db-crm`） | 内网 | 忠诚度/CRM 后端 — 客户、append-only 积分 ledger、奖励；POS 无关。见 [ADR-0021](docs/decisions/0021-loyalty-crm-domain.md) |

### Satellite 卫星 apps

| App | 路径 | 技术栈 | 生产 URL | 角色 |
|---|---|---|---|---|
| **crew-web** | [`apps/crew-web`](apps/crew-web) | Next.js 16 + Tailwind v4 + React 19 | `crew.example.com`（前厅 UI 仍在完善） | 西语前厅备料 App：PIN 登录、记录损耗 / 收货 / 查看 86 缺货单 / 快速复盘。iPad + 手机优先，ES 默认 + EN 可切换。 |
| **legal-site** | [`apps/legal-site`](apps/legal-site) | 纯 HTML/CSS + nginx | `legal.example.com` | Clover App Market 上架要求的 EULA + 隐私政策 + 支持页。零依赖 markdown -> HTML 构建，源文档在 [`docs/legal/`](docs/legal/)。 |
| **marketing-site** | [`apps/marketing-site`](apps/marketing-site) | 纯 HTML/CSS/JS + nginx | `www.example.com` | 面向顾客的 Anytown 门店营销站 — 菜单、礼品卡、营业时间、商场地图。无追踪、严格 CSP。 |
| **order-web** | [`apps/order-web`](apps/order-web) | Next.js 16 + Tailwind v4 + React 19 | `order.example.com` | 面向顾客的在线点单（order-ahead / 取餐）— 浏览菜单、自助配卷、Clover Hosted Checkout，到 Anytown 取餐。手机优先，从 marketing-site 链入。见 [ADR-0025](docs/decisions/0025-online-ordering-architecture.md)。 |
---

## Packages（共享包）

| 包 | 路径 | 职责 |
|---|---|---|
| **contracts** | [`packages/contracts`](packages/contracts) | 跨 app 的 DTO 用 Zod schema + TypeScript 类型集中描述；iOS 端通过 codegen 生成 Swift 版本 |
| **auth** | [`packages/auth`](packages/auth) | Passkey（WebAuthn）+ Argon2id 密码 + cookie 会话，被 kds-api / kds-web / backoffice-web 共用；同时导出 `@rop/auth/crew` 给 inventory crew session + PIN |
| **db-kds** | [`packages/db-kds`](packages/db-kds) | KDS 业务表的 Prisma schema、迁移、生成的客户端（tickets / orders / merchants / sync state） |
| **db-auth** | [`packages/db-auth`](packages/db-auth) | 鉴权表的 Prisma schema / 迁移 / client（`web_admin_accounts`、`web_authn_credentials`）。和 `db-kds` 在同一个物理 Postgres，仅在包边界拆开 —— 参见 [ADR-0015](docs/decisions/0015-extract-auth-tables-into-db-auth-package.md)。 |
| **db-inventory** | [`packages/db-inventory`](packages/db-inventory) | 库存数据库（独立的 Postgres）的 Prisma schema / 迁移 / client |
| **db-crm** | [`packages/db-crm`](packages/db-crm) | 忠诚度/CRM 表（`crm_customers`、`crm_loyalty_accounts`、append-only 的 `crm_points_ledger`、`crm_rewards`、`crm_reward_redemptions`、`crm_referrals`）的 Prisma schema / 迁移 / client。独立 Postgres（`CRM_DATABASE_URL`），仅被 crm-api 消费。见 [ADR-0021](docs/decisions/0021-loyalty-crm-domain.md)。 |

---

## 快速开始

本仓库只使用 pnpm。请运行 `pnpm install`（或 `make dev-up`）；根级
install guard 会拒绝 npm/yarn 安装。

```bash
make dev-up    # 一次性 bootstrap：装依赖 + 起 Postgres/Redis + 建库 + 迁移 + seed + 建管理员（幂等，可重复跑）
make dev       # 启动全部 5 个 app，然后打开 http://localhost:3001
# 登录：admin / admin（随时用 make admin 重置）
```

默认本地端口：

| 服务 | 端口 |
|---|---|
| kds-api | `4000` |
| kds-web | `3000` |
| backoffice-web | `3001` |
| crew-web | `3003` |
| inventory-api | `4100` |
| analytics-api | 可配置（见 `apps/analytics-api/.env.example`） |
| legal-site（预览） | `8080` |
| marketing-site（预览） | `8081` |

首次本地起库：参见 [Local Dev Guide](docs/LOCAL-DEV-GUIDE.md) + `make dev-up`。

### 收尾验证（"做完"前必跑）

```bash
pnpm lint
pnpm build
pnpm test
pnpm docs:check
pnpm test:e2e     # 改了 UI 流程时
```

---

## 接口清单

### kds-api（Floor 后端）

浏览器路由（由 `apps/kds-web` 代理）：

- `/` — 浏览器看板外壳
- `/board` — 浏览器看板路由
- `/display` — 公开顾客取餐屏（店内电视）
- `/login` — 浏览器登录
- `/setup-passkey` — Passkey 注册

API + 实时：

- `GET /api/health` — Docker / 运维健康检查
- `GET /api/auth/session`、`POST /api/auth/logout` — 浏览器会话
- `/api/auth/passkeys/*` — Passkey 注册 / 认证 / 列表 / 删除
- `GET /api/clover/install`、`GET /api/clover/oauth/callback` — 可选的 Clover OAuth
- `POST /api/clover/webhooks` — Clover webhook 接收端（Traefik mirroring 同时分发给 analytics）
- `GET /api/clover/status` — Clover 接入状态
- `GET /api/kds/tickets` — 看板快照 / 增量同步
- `POST /api/kds/tickets/:ticketId/actions` — ticket 级 KDS 动作
- `POST /api/kds/tickets/:ticketId/items/:itemKey/actions` — item 级动作
- `PUT/DELETE /api/kds/tickets/:ticketId/local-edit` — 本地 ticket 编辑
- `DELETE /api/kds/tickets/:ticketId` — 仅本地的 ticket 删除
- `GET/PUT /api/kds/config`、`GET/PUT /api/kds/settings` — 看板配置
- `POST /api/kds/demo/orders` — 喂入演示订单
- `/api/deliverect/*` — Deliverect 注册 / 订单 / 商品 / 订单状态
- `POST /api/internal/sync/orders/:orderId` — 内部手动同步单笔订单
- `/ws?merchantId=...` — 实时看板流

### inventory-api（前厅 + 后台 库存后端）

- `GET /api/inventory` — 完整 `InventoryDataset`
- `GET /api/inventory/pos/:id` — 前厅收货流程的采购单详情
- `POST /api/inventory/items/:id/toggle-86`
- `POST /api/inventory/counts` — body `InventoryCountSubmission`
- `POST /api/inventory/waste` — body `InventoryWasteSubmission`
- `POST /api/inventory/pos/:id/receive` — body `InventoryReceiveSubmission`
- `POST /api/crew/login`、`POST /api/crew/logout`、`GET /api/crew/me` — 前厅 PIN 会话（4 位 PIN，按设备 / IP 限流）
- `GET /api/admin/crew`、`POST /api/admin/crew`、`PATCH /api/admin/crew/:id`、`POST /api/admin/crew/:id/pin` — 仅经理可用的员工管理（bearer 鉴权）
- `GET /api/health`、`GET /api/ready`

前厅写入的"操作人"（`who`）一律服务端从 session 反查盖章；`/api/admin/*` 是 bearer-only 路径，由 backoffice BFF 作为可信调用方使用。

### backoffice-web（后台 UI + BFF）

页面路由（位于 [`app/(authed)/`](apps/backoffice-web/app)）：

- `/today` — 今日销售
- `/trends` — 多周期趋势
- `/dayparts` — 时段热力图
- `/compare` — 周期对比
- `/menu` — 菜单工程
- `/inventory`、`/inventory/crew` — 库存 + 员工
- `/ops` — 运营仪表盘（analytics-api admin 也在这里）
- `/settings`、`/settings/ai` — 运行期配置（模型 id、限流、kill switch，存在 `app_setting` 表；`/settings/system` 现在只是重定向）
- `/admin/board`、`/admin/devices`、`/admin/integrations`、`/admin/reset`、`/admin/users` — 从 `kds-web` 迁移过来的 KDS 管理

BFF Route Handlers（位于 `app/api/*`）—— 浏览器代码 **绝不直接** 调 analytics-api / kds-api / inventory-api：

- `/api/auth/*` — Passkey + 密码登录，包了一层 `packages/auth`
- `/api/ai/chat`、`/api/ai/sql`、`/api/ai/conversations` — AI 助手（DeepSeek 后端，参见 [ADR-0017](docs/decisions/0017-deepseek-replaces-codex.md)）
- `/api/admin/*` — KDS 管理代理（board-settings / devices / daily-reset / users / integrations）
- `/api/inventory/*` — 库存代理
- `/api/compare`、`/api/dayparts`、`/api/today`、`/api/trends`、`/api/menu` — 打到 analytics-api 的代理

### analytics-api（OLAP 管道）

- `POST /webhooks/clover` — Clover webhook 接收（验签、幂等 inbox 队列）
- `/admin/api/*` — 被 backoffice BFF 消费的 JSON 管理接口
- `/admin` — 重定向到 backoffice 的 `/ops`

任何自由形式的 SQL **必须** 走 [`src/analytics/safe-query.ts`](apps/analytics-api/src/analytics/safe-query.ts)（只允许 SELECT/WITH、schema 白名单、语句超时、写入 `audit.ai_query_log` 审计日志）。聚合优先用 `mart.sales_daily_mv` / `mart.sales_hourly_mv`，由 `mart-refresh-worker` 维护。

### 静态站

- **legal-site** — `/eula`、`/privacy`、`/support`、`/`（落地页）。严格 CSP，`script-src 'none'`。源文档在 [`docs/legal/`](docs/legal/)。
- **marketing-site** — 单页门店站，包含 hero、滚动 marquee、菜单（卷冰淇淋 / 奶茶 / Smoothie）、招牌产品、评价、画廊、礼品卡、到店信息等版块。Berry 配色在 [`apps/marketing-site/src/styles.css`](apps/marketing-site/src/styles.css)。

---

## 环境变量

主 `.env.example` 在仓库根目录。各 app 自己的：[`apps/analytics-api/.env.example`](apps/analytics-api/.env.example)、[`apps/backoffice-web/.env.example`](apps/backoffice-web/.env.example)。

常用 key（开发期写 `.env`；生产期由 `with-infisical` entrypoint 在容器启动时从 Infisical 注入，secret-zero bootstrap 值放在每个 stack 的宿主机 `.env` 里）：

| 变量 | 使用方 | 备注 |
|---|---|---|
| `APP_BASE_URL`、`APP_DOMAIN` | kds-api、kds-web | 对外 base URL + cookie domain |
| `DATABASE_URL` | kds-api、db-kds、db-auth | KDS + auth 共用 Postgres（一个物理 DB，两套 Prisma schema） |
| `INVENTORY_DATABASE_URL` | inventory-api、db-inventory | 库存独立 Postgres |
| `ANALYTICS_DATABASE_URL` | analytics-api | OLAP mart 独立 Postgres |
| `REDIS_URL` | kds-api | BullMQ + 同步队列 |
| `SESSION_SECRET` | kds-api、packages/auth | cookie 会话签名 |
| `BACKOFFICE_SESSION_COOKIE_NAME` | backoffice-web | 与 KDS cookie 区分，避免本地 3000/3001 冲突 |
| `WEB_LOGIN_USERNAME`、`WEB_LOGIN_PASSWORD_HASH` | kds-api | Argon2id，用下方命令生成 |
| `WEBAUTHN_RP_ID` | kds-api、backoffice-web | 必须与浏览器 hostname 一致；生产必须 HTTPS |
| `INTERNAL_API_BASE_URL` | kds-web、backoffice-web | SSR 反代用的后端地址 |
| `INVENTORY_INTERNAL_TOKEN` | inventory-api、backoffice-web BFF | backoffice 侧库存写入的可信 bearer |
| `CREW_SESSION_SECRET`、`CREW_PIN_PEPPER` | inventory-api、packages/auth/crew | 生产必填；必须与最初 seed `pin_lookup` 索引时使用的值一致 |
| `CLOVER_MERCHANT_ID`、`CLOVER_TOKEN` | kds-api、analytics-api | 静态商户 + token（当前主接入路径） |
| `CLOVER_APP_ID`、`CLOVER_APP_SECRET`、`CLOVER_WEBHOOK_AUTH_CODE` | kds-api | 可选 — Clover OAuth 路径 |
| `AI_TOKEN_ENCRYPTION_KEY` | kds-api | 32 字节 hex（64 字符）。db-kds 里 POS provider token（Clover/Square/Deliverect）落盘加密的主密钥；与 backoffice 的 `APP_SETTING_ENCRYPTION_KEY` 是**两把不同的 key**。Phase 4.5+ 必填。 |
| `DELIVERECT_API_URL`、`DELIVERECT_WEBHOOK_SECRET`、`DELIVERECT_WEBHOOK_SIGNATURE_HEADER` | kds-api | 可选 — Deliverect 第二 provider |

生成 `WEB_LOGIN_PASSWORD_HASH`：

```bash
pnpm --filter @rop/kds-api exec node --input-type=module \
  -e "import { hash, Algorithm } from '@node-rs/argon2'; console.log(await hash(process.argv[1], { algorithm: Algorithm.Argon2id }));" \
  "replace-with-your-password"
```

Agent / 运维用的 secret 走 [Agent Secret Workflow](docs/agent-secret-workflow.md)：**1Password** 是本地权威源，**GitHub repo secrets** 是 CI/CD 镜像，生产运行时 secret 由 `with-infisical` entrypoint 在容器启动时从 **Infisical** 注入（[ADR-0020](docs/decisions/0020-adopt-infisical-for-runtime-secrets.md)），secret-zero bootstrap 值放在每个 stack 的宿主机 `.env`（模板 `.env.prod.example`）里。**永远不要** 把凭据写进 `compose/*.yml` —— 它们被签入 git。

---

## 部署

生产环境跑在单台 Oracle ARM 云主机上。[`compose/`](compose/) 下共 9 个自包含的 `docker compose` stack，通过 SSH 部署上线 —— 没有编排器、没有控制面板（见 Dokploy 移除 ADR，它替代了 ADR-0005 + ADR-0007）。九个 stack：

| Stack | 文件 | 对外 host |
|---|---|---|
| KDS | [`compose/kds.yml`](compose/kds.yml) | `kds.example.com` |
| Analytics | [`compose/analytics.yml`](compose/analytics.yml) | `analytics.example.com` |
| Backoffice | [`compose/backoffice.yml`](compose/backoffice.yml) | `backoffice.example.com` |
| Inventory | [`compose/inventory.yml`](compose/inventory.yml) | 内网 |
| Crew | [`compose/crew.yml`](compose/crew.yml) | `crew.example.com`（前厅 UI 仍在完善） |
| Legal | [`compose/legal.yml`](compose/legal.yml) | `legal.example.com` |
| Marketing | [`compose/marketing.yml`](compose/marketing.yml) | `www.example.com` |
| CRM | [`compose/crm.yml`](compose/crm.yml) | `crm.example.com`（调用方为内网；忠诚度上线前 STAGED、暂未部署） |
| Order | [`compose/order.yml`](compose/order.yml) | `order.example.com` |

同主机上的 legacy Traefik 仍然作为公网边缘（DNS-01 + Cloudflare 签 `*.example.com` 通配证书）；所有 stack 的容器都单挂在同一个共享外部 bridge `rop-net` 上，它同时承载跨 stack 服务间 DNS 和入口流量（Traefik 通过每个服务的 `traefik.docker.network=rop-net` label 发现已路由的服务）。数据存储是带 named volume 的普通 compose 服务（`postgres-kds`、`redis-kds`、`postgres-analytics`、`postgres-inventory`；`postgres-crm` 为 staged）。详见 [ADR-0527](docs/decisions/0527-collapse-to-single-app-network.md)。

### CI / CD —— 合并不等于部署

PR 合到 `main` 是 AI 友好的：CI 绿 -> AI 可自合并。**部署是单独的、手动触发的步骤**（参见 [ADR-0014](docs/decisions/0014-manual-deploy-trigger.md)）：

```bash
# 默认增量：只重建自上次部署以来有改动的 app。
gh workflow run build-images.yml --ref main
gh run list --workflow=build-images.yml --limit 1 --json databaseId,status,url \
  --jq '.[0] | "Run #\(.databaseId): \(.status) -> \(.url)"'
```

该 dispatch 会在自托管 Mac runner 上构建 `linux/arm64` 镜像（[ADR-0008](docs/decisions/0008-cutover-arm64-runner-to-mac-mini.md)），推送到 `ghcr.io/example-org/rop-<app>:main`（同时打 `:<sha>` 标签），然后 SSH 到 Oracle 主机执行 `scripts/deploy-stack.sh <stack>`（git 同步后 `docker compose pull && up -d`）。运行时 secret 在容器启动时从 Infisical 注入（[ADR-0020](docs/decisions/0020-adopt-infisical-for-runtime-secrets.md)）—— 不再有 webhook、不再有控制面板。完整的 day-2 runbook（重发、回滚、灾备）在 [`OPERATIONS.md`](OPERATIONS.md)。

---

## 架构不变量（Iron Laws）

仓库通过 ESLint、doc-drift 脚本和 contract 同步检查在构建期强制执行 **五条 Iron Laws**，详见 [`AGENTS.md`](AGENTS.md) 与 [ADR-0002](docs/decisions/0002-five-iron-laws.md)：

1. **数据库边界** —— 每个 app 拥有自己的 Postgres，禁止跨 app 引入对方的 DB client。
2. **Contract 边界** —— 跨 app 的 DTO 一律走 `packages/contracts`，禁止手写。
3. **Auth 边界** —— Passkey / cookie / session 逻辑只在 `packages/auth` 里实现。
4. **Floor vs Backoffice** —— `kds-web` / `crew-web` 是 Floor（厨房电视、线工），`backoffice-web` 是后台（店主、经理）。不要混。
5. **读不是写** —— `analytics-api` 是只读 OLAP；backoffice 永不直接写两个 OLTP 库。

要故意越界，必须写 ADR **并** 加一个引用该 ADR 的范围豁免（[ADR-0011](docs/decisions/0011-ai-tables-bounded-exception.md) 是范例）。静悄悄越界会让 `pnpm lint` / `pnpm docs:check` 红。

---

## 文档

- [架构图](ARCHITECTURE.md)（[中文](ARCHITECTURE.zh-CN.md)）
- [运维与 day-2 ops](OPERATIONS.md)（[中文](OPERATIONS.zh-CN.md)）
- [决策记录（ADRs）](docs/decisions/)
- [Agent Secret Workflow](docs/agent-secret-workflow.md)
- [Web UI Testing Auth](docs/web-ui-testing-auth.md)
- [多 provider KDS 路线图](docs/multi-provider-kds-roadmap.md)
- [YRUI Design Tokens](docs/yrui-design-tokens.md) · [YRUI Component Map](docs/yrui-component-map.md)
- [运维与部署 runbook](OPERATIONS.md)

---

## 说明

- **这是多店铺（multi-location）架构，不是多租户 SaaS**：一个品牌、多家自营门店，跨店可见是特性而非泄漏（见 [docs/multi-location.md](docs/multi-location.md)、[ADR-0018](docs/decisions/0018-multi-location-architecture.md)）。POS 衍生数据（KDS、分析）按 `merchantId` 划分，品牌自有数据（库存）按 `locationId` 划分；`Location` 注册表位于 `merchantId` 之上，`PosAccount` 让非 Clover POS（如 Square，已作为 2 号店接入）可被接入。每店的 Clover/Square token 加密存于 `clover_merchants` / `pos_accounts`。
- 父目录 `Icecream/` 下的老 Clover Python 脚本在这里 **故意没用**。
- 当前 Clover 主接入路径是 **静态 token**：在 Backoffice 管理页保存活跃 token；`.env` 里的值是可选的 bootstrap / fallback。OAuth 仍然保留可用。
- 生产 Passkey 需要 HTTPS，并且 `WEBAUTHN_RP_ID` 必须稳定地匹配浏览器 hostname。
