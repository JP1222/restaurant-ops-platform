# Example Kitchen — 运维与部署手册

> 🌐 [English](OPERATIONS.md) · **中文**
>
> 本文为英文版的人工同步镜像，可能滞后；两版不一致时**以英文版为准**。
> 最近审阅：2026-06-04 · 对应 Oracle (ARM) 生产环境

本文档是 Example Kitchen 所有运维相关问题的统一入口：系统怎么搭、怎么部署、怎么维持运行、出问题怎么救回来。每个细分主题的权威手册（[`.github/OBSERVABILITY.md`](.github/OBSERVABILITY.md)、[`compose/README.md`](compose/README.md)）仍然是各自领域的最终依据；本文档把它们串起来并补齐空白。

> **部署已迁出 Dokploy + Docker Swarm。** 生产环境现在把每个 app 作为独立的 `docker compose` stack 跑在 Oracle 主机上，通过 SSH 部署（记录在 Dokploy-removal ADR 里，它取代了 [ADR-0005](docs/decisions/0005-dokploy-over-coolify.md) 和 ADR-0007）。compose / CI / 密钥机制以及线上主机切换（infra URL 已重新指向、机器上旧的 Dokploy/Swarm 安装已拆除）都已完成；下文描述的就是线上状态。

---

## 目录

1. [系统拓扑](#1-系统拓扑)
2. [首次生产部署](#2-首次生产部署)
3. [CI/CD 流程](#3-cicd-流程)
4. [日常运维](#4-日常运维)
5. [可观测性](#5-可观测性)
6. [故障排查](#6-故障排查)
7. [安全与密钥](#7-安全与密钥)
8. [灾备与备份](#8-灾备与备份)
9. [附录](#9-附录)

---

## 1. 系统拓扑

### 1.1 鸟瞰图

```
                       Internet
                          │
              Cloudflare DNS (灰云 / DNS only)
                          │
                    Oracle ARM VM (单节点, 24 GB RAM)
                          │
        ┌─────────────────┴─────────────────────────────────┐
        │                                                   │
   Host Traefik                              自托管 GHA Runner
   (遗留, file +                              (在 Mac Mini 上；构建
    docker provider)                          arm64 GHCR 镜像，再 SSH
        │                                       到本主机部署)
        │
        ├── kds.example.com ─────────► kds compose stack (rop-kds)
        │                                       ├─ postgres-kds (Postgres 16, 命名卷)
        │                                       ├─ redis-kds    (Redis 7, 命名卷)
        │                                       ├─ migrate / migrate-auth (一次性 prisma)
        │                                       ├─ kds-api     (Fastify, :4000)
        │                                       ├─ kds-worker × 2 (BullMQ)
        │                                       └─ kds-web     (Next.js, :3000)
        │
        ├── analytics.example.com ────► analytics compose stack (rop-analytics)
        │                                       ├─ postgres-analytics (Postgres 16, 命名卷)
        │                                       └─ analytics-api (:3100)
        │
        ├── backoffice.example.com ───► backoffice compose stack (rop-backoffice)
        │                                       └─ backoffice-web (Next.js, :3001)
        │                                          (自己没有 DB —— 通过 rop-net
        │                                           bridge 用 postgres-kds + redis-kds)
        │
        ├── inventory.example.com ────► inventory compose stack (rop-inventory)
        │                                       ├─ postgres-inventory (Postgres 16, 命名卷)
        │                                       └─ inventory-api (:4100)
        │
        ├── crew / order / legal / marketing ► 各自一个独立 compose stack
        │                                       (crm staged —— 文件在，未部署)
        │
        └── metrics.example.com ──────► Grafana (可观测性栈, 主机 compose)
```

每个 stack 都是一个自包含的 `compose/<stack>.yml`（目录名是历史遗留），由 plain `docker compose` 拉起。没有控制面：数据存储就是普通的 compose 服务，挂命名卷；跨 stack 的 DNS 走共享的外部 bridge `rop-net`（例如 backoffice → `postgres-kds:5432`）。数据存储不发布任何主机端口 —— 只通过 compose 网络可达。

### 1.2 服务清单

| Compose stack | 服务 | 镜像 | 端口 | 公开域名 | 备注 |
|---|---|---|---|---|---|
| `kds` | `postgres-kds` | `postgres:16-alpine` | —（无主机端口） | — | 普通 compose 服务，命名卷 `postgres-kds-data`。DB `rop_kds`。通过 `rop-net` 访问。 |
| `kds` | `redis-kds` | `redis:7-alpine` | —（无主机端口） | — | 普通 compose 服务，命名卷 `redis-kds-data`。BullMQ + sessions。 |
| `kds` | `migrate` | `ghcr.io/example-org/rop-kds-api:main` | — | — | `restart: "no"`。运行 `prisma migrate deploy`（db-kds）后退出，gate 住 kds-api / kds-worker 的启动。 |
| `kds` | `migrate-auth` | `ghcr.io/example-org/rop-kds-api:main` | — | — | `restart: "no"`。对同一个 Postgres 跑 db-auth 的 Prisma 迁移（ADR-0015）。baseline 幂等。 |
| `kds` | `kds-api` | `ghcr.io/example-org/rop-kds-api:main` | 4000 | `kds.example.com` (`/api`, `/ws`, `/admin`) | Fastify。负责 Clover 摄取、KDS 状态、WebSocket fanout。 |
| `kds` | `kds-worker` | 同 kds-api 镜像 (启动命令为 `node dist/worker.js`) | — | — | `replicas: 2`。BullMQ workers — Clover 同步、出餐、daily reset。 |
| `kds` | `kds-web` | `ghcr.io/example-org/rop-kds-web:main` | 3000 | `kds.example.com`（兜底） | Next.js Floor 端 — board、customer display、login。Admin 已迁出（301 跳到 backoffice）。 |
| `analytics` | `postgres-analytics` | `postgres:16-alpine` | —（无主机端口） | — | 普通 compose 服务，命名卷 `postgres-analytics-data`。DB `rop_analytics`。独占自己的 Postgres（铁律 1/5）。 |
| `analytics` | `analytics-api` | `ghcr.io/example-org/rop-analytics-api:main` | 3100 | `analytics.example.com` (`/webhooks/clover`, `/admin`) | Node http + 原生 SQL。Clover→Postgres 数据 mart 流水线。 |
| `backoffice` | `backoffice-web` | `ghcr.io/example-org/rop-backoffice-web:main` | 3001 | `backoffice.example.com` | Next.js admin 壳。唯一的 admin 入口 — 通过 BFF 调用 kds-api 和 analytics-api。自己没有 DB；通过 `rop-net` 用 `postgres-kds` + `redis-kds`。 |
| `legal` | `legal-site` | `ghcr.io/example-org/rop-legal-site:main` | 80 | `legal.example.com` | nginx 静态 — Clover Marketplace 上架用的 EULA / 隐私 / 支持站。 |
| `marketing` | `marketing-site` | `ghcr.io/example-org/rop-marketing-site:main` | 80 | `www.example.com` | nginx 静态 — 面向顾客的营销站。 |
| `crew` | `crew-web` | `ghcr.io/example-org/rop-crew-web:main` | 3003 | `crew.example.com` | Next.js Floor 库存 app — PIN 登录、报废 / 收货 / 86 / 重新盘点；通过同源 BFF 连 inventory-api。 |
| `inventory` | `postgres-inventory` | `postgres:16-alpine` | —（无主机端口） | — | 普通 compose 服务，命名卷 `postgres-inventory-data`。DB `rop_inventory`。独占自己的 Postgres（铁律 1）。 |
| `inventory` | `migrate` | `ghcr.io/example-org/rop-inventory-api:main` | — | — | `restart: "no"`。运行 `prisma migrate deploy` + `ensure-singletons.sql` 后退出，gate 住 inventory-api 启动。 |
| `inventory` | `inventory-api` | `ghcr.io/example-org/rop-inventory-api:main` | 4100 | `inventory.example.com`（内部；经 crew + backoffice BFF） | Fastify。库存的唯一写路径 — 物料、配方、供应商、报废、盘点、采购单 — 外加 crew PIN 认证。 |
| `order` | `order-web` | `ghcr.io/example-org/rop-order-web:main` | 3004 | `order.example.com` | Next.js 顾客点单 — 菜单 → build a roll → Clover Hosted Checkout。BFF 调 kds-api `/api/order/*`。 |
| `crm` | `postgres-crm` + `crm-*` | `postgres:16-alpine` + `ghcr.io/example-org/rop-crm-*:main` | 4200 (api) | —（staged） | **Staged** — `compose/crm.yml` 存在、带 `postgres-crm`（命名卷 `postgres-crm-data`），但 stack 还没部署。 |

### 1.3 网络分层

每个 stack 里的每个 app container 都**单挂在同一个外部 bridge** `rop-net` 上（[ADR-0527](docs/decisions/0527-collapse-to-single-app-network.md)）：

| 网络 | 驱动 | 范围 | 用途 |
|---|---|---|---|
| `rop-net` | bridge | `external: true`（主机创建） | **全部。** 东西向 DNS —— 同 stack 内（`kds-api` ↔ `kds-worker` ↔ `postgres-kds` ↔ `redis-kds`）和跨 stack（backoffice → `postgres-kds`、inventory-api → analytics-api）—— **以及**入口（host Traefik 通过每个服务的 `traefik.docker.network=rop-net` label 在这里发现已路由的服务） |

`rop-net` 取代了旧的 Docker Swarm `dokploy-network` overlay。它是个普通的外部 bridge：每个服务都加入它，按 compose 服务名解析任意对端 —— 无论在自己 stack 还是别的 stack（`postgres-kds:5432`、`redis-kds:6379`）。app 容器上**刻意**不放 per-stack `internal` 网络、也不放 `traefik-servicenet` 成员关系：一个容器同时挂在 ≥2 个共享 bridge 上时，Docker 内嵌 DNS 解析对端名会返回一个有歧义的 IP（就是触发 [ADR-0527](docs/decisions/0527-collapse-to-single-app-network.md) 的 Phase B 东西向故障），而把每个服务都单挂在一个 bridge 上，名字→IP 的解析就没有歧义了。不再需要 `--default-addr-pool` 覆盖 —— 没有 Swarm overlay pool 会和 Oracle 的 `10.0.0.0/8` VPC 冲突了。

### 1.4 数据所有权（铁律 #1）

每个 app **独占自己的 Postgres database**。跨 app 不允许直接 import 数据库 client。

| 数据库 | 拥有者 | 谁在用 | 迁移机制 |
|---|---|---|---|
| `postgres-kds` | kds-api | kds-api、kds-worker、**backoffice-web**（共享认证表） | Prisma — `packages/db-kds/prisma/migrations/`（db-kds）+ `packages/db-auth/prisma/migrations/`（db-auth，ADR-0015），由 `migrate` + `migrate-auth` Compose 服务执行 |
| `postgres-analytics` | analytics-api | 只有 analytics-api | 原生 SQL — `apps/analytics-api/sql/migrations/`，由 app 自己启动时执行 |
| `postgres-inventory` | inventory-api | 只有 inventory-api | Prisma — `packages/db-inventory/prisma/migrations/`，由 inventory 的 `migrate` Compose 服务执行 |

每个 `postgres-*` 现在都是它所在 stack 里的一个普通 compose 服务、挂命名卷 —— 没有单独的 provision 步骤，没有控制面。backoffice-web 通过 `rop-net` bridge 访问 `postgres-kds`（它自己没有数据存储）。

backoffice 之所以能共享 KDS 的 Postgres，只是因为它复用 `WebAdminAccount` + `WebAuthnCredential` 这两张表做 SSO。它**绝不**写 KDS 业务表。

### 1.5 服务间信任

| 调用方 → 被调用方 | 认证 | 持有 bearer 的环境变量 |
|---|---|---|
| Backoffice → analytics-api `/admin/api/*` | `Authorization: Bearer …` | `ANALYTICS_ADMIN_TOKEN`（值要等于 analytics-api 的 `ADMIN_TOKEN`） |
| Backoffice → kds-api `/api/admin/kds/*` | `Authorization: Bearer …` | `KDS_INTERNAL_ADMIN_TOKEN`（两侧值相同） |
| Clover webhook → kds-api / analytics-api | Clover 签名 + `CLOVER_WEBHOOK_AUTH_CODE` | Infisical（`with-infisical`） |

如果某个 bearer 没设，被调用侧返回 `503 admin_not_configured`（fail-closed）。`ANALYTICS_ADMIN_TOKEN` 和 `KDS_INTERNAL_ADMIN_TOKEN` 是独立的 — 轮换其中一个不影响另一个。

---

## 2. 首次生产部署

本章是从一台白板 Oracle ARM VM 走到生产就绪的完整路径。已经在跑的环境跳到 §4。

### 2.1 前置条件

| 要求 | 原因 |
|---|---|
| Oracle Cloud ARM 实例（Ampere A1，24 GB RAM，Ubuntu 24.04） | 免费层够用（~6 GB 工作集 + 可观测性栈） |
| 公网 IP + Cloudflare DNS 区域（`example.com` 家族） | 用 HTTP-01 ACME 挑战申请 TLS 证书 |
| GitHub 仓库 admin 权限（Settings → Secrets/Actions） | Workflows 需要 `ORACLE_SSH_*`、`SLACK_*` secrets |
| 主机上有 `docker`、`docker compose`、`git` | 部署脚本和每个 stack 都以 plain `docker compose` 跑 |
| 主机上有仓库 checkout 在 `~/restaurant-ops-platform` | `scripts/deploy-stack.sh` 会把它 git-sync 到 `origin/main` 再从那里跑 compose |
| 1 把部署 SSH key（主机）+ 1 把超级用户 SSH key（运维） | GHA runner 用部署 key SSH 进来；运维 key 用于破窗 |
| 一个 Infisical 机器身份（"secret zero"） | `with-infisical` 用它在容器启动时拉取运行时 secret（ADR-0020） |

### 2.2 准备主机

没有控制面要装。主机只需要 Docker、一份仓库 checkout，以及外部 bridge 网络 `rop-net`（在 §2.4 创建）。

```bash
# 在 Oracle 主机上，一次性。（Docker Engine + compose 插件用官方便捷脚本或 apt；
# 然后把仓库 clone 到约定路径。）
git clone https://github.com/example-org/restaurant-ops-platform.git ~/restaurant-ops-platform
```

`scripts/deploy-stack.sh` 每次都会 `git fetch` 并硬重置这份 checkout 到 `origin/main` 再跑 compose，所以工作树只要存在、且 track 正确的 remote 就行。被 gitignore 的 `compose/*.env` 文件能在 reset 后保留。

### 2.3 遗留的 host Traefik

restaurant-ops-platform 的 Traefik 用 `host` 网络模式跑在主机上（Dokploy 移除不影响它）。每个已路由的 compose 服务用 `traefik.*` labels 自我声明、并固定 `traefik.docker.network=rop-net`，于是 Traefik 在扁平的 `rop-net` bridge 上解析后端（它从主机路由表直达该 bridge），而不是在它的 provider 默认网络上（[ADR-0527](docs/decisions/0527-collapse-to-single-app-network.md)）。TLS 和路由不变。

Traefik 静态配置（主机的 `/etc/traefik/traefik.yml`）：

```yaml
providers:
  docker:
    # Traefik 的 provider 默认网络；每个已路由的 stack 用
    # traefik.docker.network=rop-net label 按服务覆盖它（ADR-0527）。
    network: traefik-servicenet
    exposedByDefault: false
  file:
    directory: /etc/traefik/dynamic
    watch: true

certificatesResolvers:
  production:
    acme:
      email: ops@example.com
      storage: /etc/traefik/acme.json
      httpChallenge:
        entryPoint: web
```

Clover webhook fan-out（同一个请求复制到 kds-api 和 analytics-api）需要把 [`infrastructure/traefik/dynamic/clover-webhook-fanout.yml`](infrastructure/traefik/dynamic/clover-webhook-fanout.yml) 放到 `/etc/traefik/dynamic/`，Traefik 会热重载。

验证：`curl -s http://127.0.0.1:8080/api/http/routers | jq '.[].name'` 在第一次 compose 部署后能看到预期的 router。

### 2.4 创建外部 Docker 网络

扁平的 app bridge `rop-net` 必须在任何 compose stack 拉起**之前**就存在 —— 每个服务都单挂在它上面（[ADR-0527](docs/decisions/0527-collapse-to-single-app-network.md)）。遗留的 host Traefik 自己的 `traefik-servicenet` 网络（§2.3）是独立的、已经存在；app stack 既不创建也不加入它。

```bash
docker network create --driver bridge rop-net
docker network ls --filter name=rop-net
```

### 2.5 配置 Cloudflare DNS

每个公开域名都加 A 记录，**DNS only（灰云）** 指向 Oracle 公网 IP：

```
kds.example.com         A  <oracle-ip>   DNS only
analytics.example.com   A  <oracle-ip>   DNS only
backoffice.example.com  A  <oracle-ip>   DNS only
inventory.example.com   A  <oracle-ip>   DNS only
crew.example.com        A  <oracle-ip>   DNS only
order.example.com       A  <oracle-ip>   DNS only
legal.example.com       A  <oracle-ip>   DNS only
www.example.com         A  <oracle-ip>   DNS only
metrics.example.com     A  <oracle-ip>   DNS only
```

灰云是刻意为之 — HTTP-01 ACME 需要直连。生产稳定后可以切到代理（橙云）+ DNS-01 + CF API token，但不是必须。

### 2.6 数据存储：没有单独的 provision 步骤

不再有外部托管的 Postgres/Redis 资源。每个数据存储就是它所在 stack 文件里声明的一个普通 compose 服务，挂命名卷：

| Stack | 数据存储服务 | 命名卷 |
|---|---|---|
| `kds` | `postgres-kds`、`redis-kds` | `postgres-kds-data`、`redis-kds-data` |
| `analytics` | `postgres-analytics` | `postgres-analytics-data` |
| `inventory` | `postgres-inventory` | `postgres-inventory-data` |
| `crm`（staged） | `postgres-crm` | `postgres-crm-data` |

`backoffice` 自己没有数据存储 —— 它加入 `rop-net`、按服务名访问 `postgres-kds` + `redis-kds`。卷在第一次 `docker compose up` 时创建，无需提前 provision。

### 2.7 各 stack 的主机 env 文件

每个 stack 用它自己那个轻量、**被 gitignore** 的 env 文件 `compose/<stack>.env` 拉起。已提交的模板是 [`.env.prod.example`](.env.prod.example) —— 把每一段复制到每个 stack 各自的真实文件里（一个共享文件**不行**：`DATABASE_URL` / `SESSION_SECRET` 在 kds 和 backoffice stack 里含义不同）。

这些文件只承载不可约的主机侧 bootstrap，**不**承载应用 secret：

- **Infisical secret-zero** —— `INFISICAL_MACHINE_CLIENT_ID` / `INFISICAL_MACHINE_CLIENT_SECRET`（Universal Auth 机器身份）。这是主机上唯一的真 secret；`with-infisical` 用它在容器启动时拉取其余一切。
- **本地数据存储凭据** —— `POSTGRES_PASSWORD`（全新卷；不对网络暴露）。
- **指向本地 compose DNS 的 infra URL** —— 例如 `DATABASE_URL=postgresql://postgres:postgres@postgres-kds:5432/rop_kds`、`REDIS_URL=redis://redis-kds:6379`、`INVENTORY_DATABASE_URL=…@postgres-inventory:5432/rop_inventory`。
- **app 直接读的非 secret 配置**（例如 `APP_BASE_URL`、`WEBAUTHN_RP_ID`、`CLOVER_REGION`）。

> ⚠️ **Infisical 覆盖规则。** `with-infisical` 入口在启动时会**覆盖**同名进程 env。所以你在主机 env 文件里设的、同时又存在于 Infisical `prod` scope 的 infra URL，会被 Infisical 的值替换掉。因为上面这些 URL 现在指向**本地** compose DNS，Infisical 里留下的陈旧 overlay-DNS 值（例如 `postgres-kds-<suffix>`）会赢，容器就连不上数据库。把 infra URL 留在主机 `.env` 文件里、**别放进 Infisical**（或在 Infisical 里把它们改成本地 DNS）。推荐姿态：infra URL 只活在主机 `.env`。

其余一切 —— `SESSION_SECRET`、`CLOVER_*`、各 `*_ADMIN` / `*_INTERNAL` token、`CREW_*`、`APP_SETTING_ENCRYPTION_KEY`、`AI_TOKEN_ENCRYPTION_KEY`、`DEEPSEEK_API_KEY` …… —— 由 `with-infisical` 从 Infisical `prod` scope 注入（ADR-0020）。完整 secret 模型见 §7.1。

`compose/<stack>.yml` 里每个变量都用 `${VAR:-default}` 形式声明，所以在 Infisical 接好之前 stack 也能（用空 / no-op 值）启动。CI 的 `validate-compose.yml` 跑 `docker compose config` 抓结构性问题；不再有对任何外部存储的 env-drift 校验器。

### 2.8 配置 GitHub Actions secrets

仓库 → Settings → Secrets and variables → Actions。部署路径只需要两个主机 secret，外加通知 webhook：

| Secret | 谁在用 | 值 |
|---|---|---|
| `ORACLE_SSH_KEY` | `build-images.yml`（部署步骤） | 私钥，其公钥放在主机的 `~/.ssh/authorized_keys`。runner SSH 进来跑 `scripts/deploy-stack.sh`。 |
| `ORACLE_SSH_HOST` | `build-images.yml`（部署步骤） | `user@203.0.113.10`（Oracle 主机）。 |
| `SENTRY_AUTH_TOKEN`、`SENTRY_ORG` | `build-images.yml`（构建镜像时上传 source-map / release） | 来自 Sentry。 |
| `SLACK_WEBHOOK_URL` | `slack-notify.yml` | Slack → api.slack.com/apps → 创建 app → Incoming Webhooks → Add New Webhook to Workspace → 选频道 → 复制 URL |

`ORACLE_SSH_KEY` / `ORACLE_SSH_HOST` 这对**取代**了旧的 Dokploy 控制面 secret（`DOKPLOY_API_KEY`、所有 `DOKPLOY_*_COMPOSE_ID`、所有 `DOKPLOY_WEBHOOK_*`）—— 那些都已删除。

GitHub Actions 不会直接读取 1Password。这些 repo secrets 是 GitHub 侧的镜像，通过本地已登录 1Password 的 shell 执行
`op run --env-file=.env.tpl -- scripts/sync-github-secrets-from-agent-env.sh`
刷新。job 运行时，GitHub Actions 把 repo secret 注入 runner 环境；Mac Mini runner 只是执行 job，不是 secret 来源。

### 2.9 部署自托管 Mac Mini runner

当前 CI/build runner pool 是 Mac Mini，不是 Oracle。必需 labels：
`self-hosted`、`mac`（以及 `macmini`）。旧 Oracle runner labels 已退役，避免重型构建误跑到生产主机上。runner 需要能 SSH 到 Oracle 主机（它跑部署步骤），并具备 `docker buildx` 做 arm64 镜像构建。

### 2.10 首次部署

```bash
# 仅手动触发（ADR-0014）。构建每个 app 并部署每个 stack：
gh workflow run build-images.yml --ref main --field force_all=true
```

`force_all=true` 会忽略增量 paths-filter、构建 matrix 里的每个 app。在 GitHub Actions UI 看进度；冷缓存时最慢 app 大约 5-10 分钟。每个 build job 把 `:main` + `:<sha>` 推到 GHCR，然后部署步骤 SSH 到主机跑 `scripts/deploy-stack.sh <stack>` —— 它把主机 checkout git-sync 到 `origin/main`，再跑 `docker compose -f compose/<stack>.yml [--env-file compose/<stack>.env] pull && up -d`。

首次 CI 跑之前/之后，你也可以在主机上手动拉起任意 stack：

```bash
bash ~/restaurant-ops-platform/scripts/deploy-stack.sh kds
```

### 2.11 冒烟测试

```bash
# 健康端点 (通过 Traefik 走 TLS)
curl -fs https://kds.example.com/api/health
curl -fs https://analytics.example.com/healthz
curl -fs https://backoffice.example.com/

# 登录页面（应该返回 HTML，不是 5xx）
curl -fsI https://kds.example.com/login | head -1
curl -fsI https://backoffice.example.com/login | head -1
```

然后在 backoffice 上通过 `/admin/integrations/clover` 创建第一个 admin 用户（默认只支持 passkey；如果要用密码兜底，按 [`README.md`](README.md) 里的代码片段用 `pnpm --filter @rop/kds-api exec node …` 生成 Argon2id hash）。

---

## 3. CI/CD 流程

### 3.1 Workflow 全景图

运维相关的 workflow 在 [`.github/workflows/`](.github/workflows/)：

| Workflow | 触发 | 作用 |
|---|---|---|
| [`ci.yml`](.github/workflows/ci.yml) | PR + push 到 main | lint、build、unit tests、E2E（在临时 Postgres + Redis 上跑 Playwright） |
| [`validate-compose.yml`](.github/workflows/validate-compose.yml) | PR + push 到 main 且改了 `compose/**` | 对每个 stack 文件跑 `docker compose config` —— 结构性校验（坏 YAML、未定义的 network/volume）。无 Dokploy、无 secret。 |
| [`build-images.yml`](.github/workflows/build-images.yml) | **仅手动 dispatch**（ADR-0014） | 在自托管 **Mac Mini** arm64 runner 上构建每个 app 的 Docker 镜像，推 `:main` + `:<sha>` 到 GHCR，然后 SSH 到主机、对每个构建的 app 跑 `scripts/deploy-stack.sh <stack>` |
| [`ghcr-cleanup.yml`](.github/workflows/ghcr-cleanup.yml) | 每周 cron | 清理 GHCR 旧 image tag；每个 app 保留 `main`、`latest` 和最近 5 个 SHA tag |
| [`slack-notify.yml`](.github/workflows/slack-notify.yml) | 上述任一 workflow `workflow_run`（仅 failure） | 失败时往 Slack 发消息 |
| `claude-review.yml` | PR | Claude 协助评审（和运维无关） |

旧的 `sync-compose-to-dokploy.yml` 已**删除** —— 没有外部存储要推 YAML 了；主机在部署时直接从它的 `origin/main` checkout 读 `compose/*.yml`。

### 3.2 `ci.yml` — merge 守门员

PR 和 main push 会跑两个 job（第三个 `validate-compose.yml` 在 compose 文件变更时单独跑 —— 见 §3.1）：

1. **`ci` (Lint, build, test)** — 执行 `pnpm lint && pnpm build && pnpm test && pnpm docs:check`（analytics-api、auth、kds-api、kds-web、backoffice 的单元测试套件）。顺序很重要，因为 `pnpm lint` 依赖 `db:generate` 和 workspace 包先 build。
2. **`e2e` (E2E + migrations)** — 临时 Postgres 16 + Redis 7 服务，对全新 DB 跑 `prisma migrate deploy`，再跑 Playwright Chromium 套件：`kds-web`（4 个 spec）+ `backoffice-web`（2 个 spec）。失败会上传 `playwright-report/` + `test-results/` 作为 7 天 artifact。

### 3.3 端到端 build → deploy 流程

```
你跑 `gh workflow run build-images.yml --ref main`（手动；ADR-0014）
        │
        ▼
┌────────────────────────────────────────────────────────────────┐
│  GitHub Actions 控制面                                          │
│  ─ 调度 jobs，并注入 GitHub repo secrets                        │
│  ─ 不读取 1Password                                             │
└────────────────────────────────────────────────────────────────┘
        │ jobs 分派给自托管 runner
        ▼
┌────────────────────────────────────────────────────────────────┐
│  Mac Mini M4 — 2 个自托管 runner                                │
│  ─ ci.yml — lint / build / test                                 │
│  ─ build-images.yml `setup` — last-built 标记 → JSON matrix     │
│  ─ build-images.yml `build` job, runs-on [self-hosted, mac]     │
│      docker buildx build --platform linux/arm64                 │
│      → ghcr.io/example-org/rop-<app>:main + :<sha>            │
│  ─ buildx 本地 cache: ~/buildx-cache/<app>/                     │
│  ─ build-images.yml `deploy` step — ssh -i $ORACLE_SSH_KEY      │
│      $ORACLE_SSH_HOST 'bash ~/restaurant-ops-platform/scripts/deploy-stack.sh <stack>' │
└────────────────────────────────────────────────────────────────┘
        │ SSH（每个构建的 stack）
        ▼
┌────────────────────────────────────────────────────────────────┐
│  Oracle Ampere A1 — plain docker compose + 主机 Traefik         │
│  ─ deploy-stack.sh: git reset --hard origin/main，然后          │
│    docker compose -f compose/<stack>.yml \              │
│      [--env-file compose/<stack>.env] pull && up -d     │
│  ─ Stacks: kds、analytics、backoffice、inventory、crew、        │
│    order、legal、marketing  (crm: staged, 未部署)               │
│  ─ 可观测性 stack：独立的主机 docker compose                    │
└────────────────────────────────────────────────────────────────┘
        │
        ▼
   任何失败 → Slack (slack-notify.yml)
```

`build` job 用 `runs-on: [self-hosted, mac]`，按 matrix 并行（一个待构建 app 一个 job）。每个 job 的部署步骤 SSH 到主机跑 `scripts/deploy-stack.sh <stack>`；`ssh` 的退出码就是远端脚本的退出码，所以失败的 `docker compose up` 会让 job 显式失败、Slack 通知。镜像总是在部署步骤之前推到 GHCR，所以部署失败也留下了可恢复的镜像。

**增量 vs 全量。** `setup` job 通过把 `HEAD` 和 `last-built` 标记对比来决定构建什么 —— `last-built` 是 orphan `deploy-state` 分支上的 `.last-built` 文件，每次成功 dispatch 后由 `advance-marker` job 自动推进。只有自上次部署以来路径有变化的 app 才重建；上次部署后批量合的 PR 全都会被拾起。`--field force_all=true` 跳过标记、构建全部；`--field skip_deploy=true` 只构建不部署（冒烟测试模式，不动生产）。如果标记缺失或陈旧（首次部署，或 `main` 被改写），workflow 会告警并回退到 force_all 语义。

各 app 触发映射（自标记以来有命中变化就重建该 app）：

| App | 触发条件 |
|---|---|
| `kds-api` | `apps/kds-api/**`、`packages/{db-kds,db-auth,contracts,auth}/**`、根 configs |
| `kds-web` | `apps/kds-web/**`、`packages/{contracts,auth}/**`、根 configs |
| `analytics-api` | `apps/analytics-api/**`、根 configs |
| `backoffice-web` | `apps/backoffice-web/**`、`packages/{auth,db-kds,contracts}/**`、根 configs |
| `inventory-api` | `apps/inventory-api/**`、`packages/{db-inventory,contracts}/**`、根 configs |
| `crew-web` | `apps/crew-web/**`、根 configs |
| `order-web` | `apps/order-web/**`、根 configs |
| `legal-site` | `apps/legal-site/**`、`docs/legal/**` |
| `marketing-site` | `apps/marketing-site/**` |

### 3.4 主机重部署流程（`scripts/deploy-stack.sh`）

对每个构建的 app，部署步骤 SSH 到主机跑 [`scripts/deploy-stack.sh`](scripts/deploy-stack.sh) `<stack>`。脚本：
1. 拿一把全局 flock（`/tmp/rop-deploy.lock`），让两个指向同一 stack 的 matrix job（例如 kds-api + kds-web → `kds`）串行。
2. 对 `~/restaurant-ops-platform` checkout 跑 `git fetch origin main` + `git reset --hard origin/main`，让 compose 文件和脚本本身都对齐 `main`。被 gitignore 的 `compose/*.env` 文件能在 reset 后保留。（如果主机 fetch 不了，就部署当前 checkout 并告警。）
3. 对 GHCR 跑 `docker compose -f compose/<stack>.yml [--env-file compose/<stack>.env] pull`（只 pull 变化的 layer；之前的 layer 已缓存在主机 docker daemon 上）。
4. 跑 `docker compose … up -d --remove-orphans` 按依赖顺序。kds 的话：`postgres-kds` + `redis-kds` 健康，然后 `migrate` + `migrate-auth` 跑到退出 0，然后 `kds-api` + `kds-worker` + `kds-web` 启动。每个 app 设了 `pull_policy: always`，所以在主机上裸跑 `up -d` 也会拉到最新 `:main`（一次发布捆绑的 schema 迁移绝不会因为陈旧本地镜像被跳过）。

某容器在 `start_period + interval × retries` 内（kds-api：10 + 5 × 6 = 40 秒）没通过 healthcheck 会被标记 unhealthy；`restart: unless-stopped` 让它持续重启。没有自动回滚 —— 见 §4.7。

### 3.5 修改 compose 文件

没有单独的 sync 步骤。在分支上改 `compose/<name>.yml`，开 PR（`validate-compose.yml` 跑 `docker compose config`），合到 main。改动在下次 `build-images.yml` 部署那个 stack 时到达生产 —— `deploy-stack.sh` 把主机 checkout git-sync 到 `origin/main`，所以它总是跑已合并的 YAML。只改 compose、不重建镜像的改动仍需要手动 dispatch 一次 `build-images.yml`（或在主机上手跑 `deploy-stack.sh`）才生效。

### 3.6 分支保护

按 [`.github/BRANCH_PROTECTION.md`](.github/BRANCH_PROTECTION.md) 设置。Required status checks：`Lint, build, test` 和 `E2E + migrations`。`Validate compose stacks`（即 `docker compose config` 检查）在 compose 文件变更时跑。

---

## 4. 日常运维

### 4.1 部署新代码

**部署仅手动触发**（ADR-0014）—— 合到 `main` **不会**滚生产。准备好发布时：

```bash
# 增量（默认）：只构建自上次部署以来有变化的 app。
gh workflow run build-images.yml --ref main

# 把 run URL 显示出来（不要阻塞等它）：
sleep 5
gh run list --workflow=build-images.yml --limit 1 \
  --json databaseId,status,url --jq '.[0] | "Run #\(.databaseId): \(.status) → \(.url)"'
```

即便在 worktree 或 feature 分支里也始终用 `--ref main` —— 部署的 source-of-truth 是 `main`。完整规则见根 [`AGENTS.md`](AGENTS.md) 的 "Deploy is user-gated" 一节（绝不无提示触发；失败不要自动重试）。

**实时看进度**：打开 https://backoffice.example.com/ops 的 **Pipeline** 标签页 — 服务健康条 + 5 段流水线 + 最近 runs + GHCR 镜像新鲜度，全部实时刷新。需要在 backoffice 环境里设 `GITHUB_PIPELINE_TOKEN`（PAT scope: `actions:read`、`read:packages`），不设的话服务健康条仍然能用。

**强制重建 + 全量重新部署**（例如怀疑 buildx cache 坏了，或 `deploy-state` 标记丢了）：`gh workflow run build-images.yml --ref main --field force_all=true`。加 `--field skip_deploy=true` 可以只 build 不部署（冒烟测试模式，不动生产）。

**在主机上手动部署单个 stack**（不走 CI）：
```bash
bash ~/restaurant-ops-platform/scripts/deploy-stack.sh kds   # git-sync 到 origin/main，然后 pull + up -d
```

### 4.2 修改 Compose YAML

1. 在分支上改 `compose/<name>.yml`。
2. 开 PR。`validate-compose.yml` 对每个 stack 跑 `docker compose config`。
3. 合到 main。
4. 改动在下次 `build-images.yml` 部署那个 stack 时到达生产（`deploy-stack.sh` 把主机 git-sync 到 `origin/main`）。只改 compose、不重建镜像的改动需要手动 dispatch（或在主机上手跑 `deploy-stack.sh`）才生效。

### 4.3 修改 env / secret

现在几乎一切都是 Infisical secret —— 在 Infisical `prod` scope 改它，然后重启消费方 stack 让 `with-infisical` 重新注入（§4.5）。每个 stack 的主机文件 `compose/<stack>.env` 里只有 Infisical secret-zero、`POSTGRES_PASSWORD`、本地 DNS infra URL，以及非 secret 配置（§2.7）。

改一个主机 `.env` 值：
```bash
ssh oracle
cd ~/restaurant-ops-platform
$EDITOR compose/kds.env          # 被 gitignore；deploy-stack.sh 的 git reset 后保留
bash scripts/deploy-stack.sh kds         # re-up 这个 stack 让它生效
```

> ⚠️ **Infisical 覆盖规则**（§2.7）：如果你在主机 `.env` 里设的某个变量同时也在 Infisical `prod` 里，启动时 Infisical 的值赢。把 infra URL 留在 Infisical 之外（或在 Infisical 里把它们改成本地 compose DNS）。

### 4.4 查日志

| 方法 | 用在什么场景 |
|---|---|
| `ssh oracle 'docker logs -f --tail 100 <container>'` | 长尾、grep、结构化分析 |
| `ssh oracle 'docker compose -f compose/<stack>.yml logs -f <service>'` | 一次看一个服务的所有副本，按 compose 服务名 |
| Grafana → Explore → Loki：`{container="..."}` | 历史搜索、跨容器关联分析 |

容器名现在是可预测的 plain-compose 名 —— `rop-<stack>-<service>-<n>`，例如 `rop-kds-kds-api-1`、`rop-kds-postgres-kds-1`。不再有 Dokploy 自动后缀。
```bash
ssh oracle "docker ps --filter 'label=com.docker.compose.project=rop-kds' --format '{{.Names}}'"
```

### 4.5 重启服务 / 进容器 shell

| 操作 | 命令（在主机上，从 `~/restaurant-ops-platform`） |
|---|---|
| 重启单个服务 | `docker compose -f compose/<stack>.yml restart <service>` |
| 重启整个 stack | `docker compose -f compose/<stack>.yml [--env-file compose/<stack>.env] up -d` |
| 重新注入 Infisical secret | 重启 stack（上一行）—— `with-infisical` 启动时重新拉取 |
| Shell | `docker exec -it <container> sh` |
| 单次执行 | `docker exec <container> <cmd>`（例如 `psql`、`redis-cli`） |

### 4.6 数据库迁移

Prisma 迁移在每次 kds stack 部署时自动跑 — `migrate`（db-kds）和 `migrate-auth`（db-auth，ADR-0015）服务设了 `restart: "no"`、跑 `prisma migrate deploy`，并通过 `service_completed_successfully` 卡住 `kds-api` / `kds-worker` 的启动。两者都设了 `pull_policy: always`，所以即便裸跑 `docker compose up -d` 也会应用一次发布捆绑的迁移。

不重部署也能查迁移状态：
```bash
ssh oracle "docker exec rop-kds-kds-api-1 node_modules/.pnpm/node_modules/.bin/prisma migrate status --schema node_modules/@rop/db-kds/prisma/schema.prisma"
```

inventory-api 的迁移通过它自己的 `migrate` 服务同理跑。analytics-api 用的是原生 SQL 迁移（`apps/analytics-api/sql/migrations/`），由 app 自己启动时跑 — 没有单独的 runner。文件顺序敏感；**永远**不要原位重编号或删文件。

### 4.7 手动回滚

没有自动回滚 —— 坏镜像只会按重启策略循环。在主机上用 plain compose 回滚：

```bash
ssh oracle
cd ~/restaurant-ops-platform

# 1. 找一个好的镜像 SHA（GHCR 保留 :<sha> 标签约 90 天）
git log --oneline main

# 2a. 如果只是镜像有问题 —— 不改 main，在主机上用一个额外 compose 文件
#     给那一个服务钉死上一个 SHA：
cat > /tmp/kds-pin.yml <<'YAML'
services:
  kds-api:
    image: ghcr.io/example-org/rop-kds-api:<good-sha>
  kds-worker:
    image: ghcr.io/example-org/rop-kds-api:<good-sha>
YAML
docker compose -f compose/kds.yml --env-file compose/kds.env \
  -f /tmp/kds-pin.yml up -d
#     （或者要持久钉死，就在分支上改 compose/kds.yml 的 `image:` 标签、
#      合并、重新部署 —— deploy-stack.sh 会 git-sync 它。）

# 2b. 如果合并的 YAML 本身有问题 —— 把主机 checkout 的那个文件 checkout 到
#     上一个好的 commit 再 re-up（下次 CI 部署会把它重置回 main）：
git fetch origin main
git checkout <good-sha> -- compose/kds.yml
docker compose -f compose/kds.yml --env-file compose/kds.env up -d
```

最干净的持久修复永远是：在 `main` 上 revert，然后 `gh workflow run build-images.yml --ref main` 让主机重新 sync 到一个好的 `origin/main`。

### 4.8 批量 / 暂缓部署

因为部署仅手动触发，"暂停"本来就是默认 —— 合到 `main` 自己不会滚生产。要把几个已合并的 PR 攒成一次部署，就等一下、准备好时跑一次增量 dispatch；`last-built` 标记意味着这一次 dispatch 会拾起自上次部署以来变化的每个 app：

```bash
gh workflow run build-images.yml --ref main
```

只想 build-only 冒烟测试、不动生产：

```bash
gh workflow run build-images.yml --ref main --field force_all=true --field skip_deploy=true
```

### 4.9 接入第二家门店（多门店）

Example Kitchen 是多**门店**架构（一个品牌、N 家门店——见 [docs/multi-location.md](docs/multi-location.md)），不是多租户 SaaS。如今绝大部分接入都已在 Backoffice 自助完成；只有一步（分析同步）在其自动化落地前仍需运维手动操作。

1. **连接该门店的 POS。**
   - *Clover：* 对新门店跑一次 per-merchant 的 OAuth 安装。它会新建一行 `CloverMerchant`（通用的 store-account 表），此时**尚未**绑定任何 Location。
   - *非 Clover（[ADR-0019](docs/decisions/0019-decouple-store-identity-from-clover.md)）：* upsert 一行带合成 id 的 store-account，provider 凭据存在 `KdsProviderConfig` 里。
2. **创建并绑定门店** —— Backoffice → Locations（需 ADMIN）。两步都是自助的：
   - **Add store** —— 设置名称与**时区**（它决定该店的“营业日”边界，务必设对）。
   - **Connect POS** —— 从第 1 步选出尚未绑定的 store-account。这会设置 `CloverMerchant.locationId`，门店随即出现在 **Store Switcher** 中，并对分析 + 库存生效。未绑定 POS 的门店会刻意显示“无数据”，而不是另一家店的数字。
3. **注册分析 sync target —— _在自动化落地前需手动_。** 向 analytics-api 的 `/admin/api/sync-targets` `POST { merchant_id, token, store_timezone, active: true }`（bearer `ANALYTICS_ADMIN_TOKEN`）。OAuth `token` 存在 kds-api 的 `clover_merchants.access_token` 里；**绝不要打日志**，并使用与第 2 步**相同的时区**（两处时区来源必须一致）。注册表约 30 秒内热加载，无需重新部署。不做这步，该店销售永远不会被采集。
4. **录入该门店的 crew** —— Backoffice → Crew，**先在 Store Switcher 里选中新门店**。每位员工会自动归到当前选中的门店，因此他们的 PIN 会话（以及记录的每一次 waste / receive / count）都自动按该店划分。自助，无需 DB 操作。
5. **配对每块 KDS 屏** —— 用该店的 `merchantId` `POST /api/kds/devices`。之后每块屏通过自己的 device token 解析出所属门店（无需 `?merchantId=`）。
6. **验证** —— 在 Store Switcher 切到新门店：库存管理自己的库存、crew 名册只显示该店的员工；一旦同步采集完成，分析 + Today/intraday 页面会用该店自己的时区展示其数字。

**非 Clover 门店的范围（[ADR-0019](docs/decisions/0019-decouple-store-identity-from-clover.md)）。** store-account 行、KDS 订单采集（provider 中立的 `KdsProviderEvent` + 每 provider 的 `normalize*Order`）、库存、crew 都是 POS 无关的，所以一家非 Clover 门店今天就能跑 **KDS + 库存 + crew**（其 store-account 需要一个占位 `accessToken`——Deliverect 的 `"<provider>:webhook"` 模式）。在该 provider 的适配器落地前仍与 **Clover 耦合**的是：**菜单**来源、**分析**采集、**线上下单支付**。所以非 Clover 的 2 号店先以 KDS 优先上线；菜单 / 分析 / 线上下单按 provider 逐步跟进。

**已知限制（在剩余多门店工作落地前）：**

- Switcher 里的 **“All stores”** 显示的是 env 默认门店的数字，而非合并汇总。
- **2 号店的线上下单尚未上线。** kds-api 的下单路径现已按门店感知——它把菜单 / 定价 / 订单路由到所选门店，并对任何不是所配置 Clover Ecommerce 商户的门店 **fail-closed 拒绝**支付——但顾客端 order-web 还没有传门店，且每店支付配置（运行时 Clover keys）尚待补齐。两者落地前，2 号店线上下单先关着。
- **分析的“营业日”分桶是按门店正确的**（analytics-api 用每店自己的时区给销售分桶；Today + intraday 已验证）。唯一仍按 Central 时区的残留，是少数分析页面**客户端默认日期范围**——属外观问题，运维可调。

---

## 5. 可观测性

权威文档：[`.github/OBSERVABILITY.md`](.github/OBSERVABILITY.md)。本节给一个快速定位 + 日常 cheatsheet。

### 5.1 可观测性栈

App 侧错误追踪走 **Sentry SaaS**（`https://sentry.io/organizations/example-org`，org `restaurant-ops-platform`，5 个 project），不是自托管端点。自托管可观测性栈负责指标 + 日志：

| URL | 工具 | 存什么 | 认证 |
|---|---|---|---|
| `https://metrics.example.com` | Grafana | 指标 + 日志 dashboard | `admin` / `GRAFANA_ADMIN_PASSWORD` |
| （只内网） | Prometheus | 时序指标 | 通过 Grafana 代理 |
| （只内网） | Loki | 容器 stdout/stderr | 通过 Grafana 代理 |

部署：
```bash
ssh oracle
cd ~/restaurant-ops-platform
cp .env.observability.example .env.observability
# 填 GRAFANA_ADMIN_PASSWORD

COMPOSE_PROJECT_NAME=rop-observability \
  docker compose --env-file .env.observability \
  -f docker-compose.observability.yml up -d --build
```

`docker-compose.observability.yml` 作为它自己的主机 compose stack 跑（`COMPOSE_PROJECT_NAME=rop-observability`），和各 app stack 分开、不在 `build-images.yml` 部署 matrix 里 —— 它在主机上手动部署和更新。

### 5.2 出问题先看哪里

| 症状 | 第一站 |
|---|---|
| 任意 app 不明 5xx | **Sentry**（sentry.io，org `restaurant-ops-platform`） — 通过 Sentry SDK 应该已经有 stack trace |
| App 慢但没报错 | **Grafana → Explore → Prometheus** — 看 `up`、queue depth |
| "14:32 左右 X 输出了什么？" | **Grafana → Explore → Loki** — `{container="rop-kds-kds-api-1"} \|= "ERROR"` |
| 部署本身失败 | **GitHub Actions** — `build-images.yml` 或 `slack-notify.yml` 告警 |
| 业务信号红（Clover 401、同步失败率、heartbeat lag） | `scripts/check-business-health.sh` cron — 见 §5.4 |

### 5.3 常用 Loki 查询

容器名遵循 plain-compose 模式 `rop-<stack>-<service>-<n>`：

```logql
{container=~"rop-kds-kds-api-.*"} |= "ERROR"
{container="rop-analytics-analytics-api-1"} |~ "(?i)clover.*401"
{container=~"rop-.*"} |= "FATAL" | json
sum(rate({container=~"rop-.*"} |= "ERROR" [5m])) by (container)
```

### 5.4 业务健康告警

[`scripts/check-business-health.sh`](scripts/check-business-health.sh) 跑 15 分钟一次的 cron，触发邮件的条件：
1. `audit.sync_runs` 失败率 > `SYNC_FAILURE_THRESHOLD_PCT`（默认 50%），窗口 `SYNC_FAILURE_WINDOW_MIN`（30 分钟）。
2. `audit.service_heartbeats` 任一 worker 子系统（9 个）lag > `HEARTBEAT_LAG_MAX_MIN`（5 分钟）。
3. Clover 401 计数 > `CLOVER_401_THRESHOLD`（1），窗口 `CLOVER_LOG_WINDOW_MIN`（60 分钟）。

安装：
```bash
crontab -e
*/15 * * * * $HOME/restaurant-ops-platform/scripts/check-business-health.sh >/dev/null 2>&1
```

抑制：相同 fingerprint 在 `SUPPRESS_WINDOW_SEC`（默认 1 小时）内不重复告警。`--force` 可绕过。

这个脚本存在的原因是 **process-level 健康检查不够** — 历史上 Clover 401 曾持续 24+ 小时而 `/healthz` 一直返回 200。

### 5.5 磁盘 & 保留

`rop-observability_*` 卷：
- `prometheus-data` — 每天 ~50 MB（30 天保留）
- `loki-data` — 每天 ~100-500 MB

查看：`docker system df -v | grep observability`。
调保留：`PROMETHEUS_RETENTION` env 变量；Loki 有自己的 config。

---

## 6. 故障排查

### 6.1 部署失败 / healthcheck 红

**症状**：`build-images.yml` 的部署步骤失败，或某 stack 在主机上起来后不健康。

1. **先看失败容器的日志** — `ssh oracle 'docker compose -f compose/<stack>.yml logs --tail 100 <service>'` 或 `docker logs -f <container>`。90% 的失败前 50 行就能看出来。
2. **常见原因**：
   - **缺 env / infra URL 错** — 某个必填值没到容器里。启动时看 zod 解析错误。检查主机的 `compose/<stack>.env` 和 Infisical `prod` scope，并记住覆盖规则（§2.7）：同时存在于 Infisical 的 infra URL 会赢过主机文件。
   - **`migrate` / `migrate-auth` 服务挂了** — 通常是 DB 连不上（`DATABASE_URL` 错，或 `postgres-kds` 还没健康）或迁移冲突。回头检查 `DATABASE_URL` 和 `prisma migrate status`。
   - **镜像还没推完** — `build-images.yml` 还在构建。等 build job 完，再重跑部署。
   - **Healthcheck 超时** — 容器起来了但比 `start_period + interval × retries` 更慢。改代码让启动更慢的话相应调大。backoffice-web 通常是 Next.js JIT 编译。
3. **快速回滚**：见 §4.7。

### 6.2 容器无限重启

`docker ps` 状态显示 `Restarting (1)` 之类。

```bash
ssh oracle
docker logs <container> --tail 100        # 崩溃原因？
docker inspect <container> | jq .State    # 退出码、重启次数
```

典型修复：
- 启动崩溃（exit code 1） → env 校验失败 → 见 §6.1。
- 信号崩溃（exit 137 = OOM kill） → 见 §6.7。
- 运行中崩溃 → 查日志里的未处理 promise rejection；Sentry 应该有 trace。

### 6.3 Clover 401 / 静默集成失败

**症状**：KDS board 不更新但 `/api/health` 返回 200；analytics dashboard 没有新销售数据。

**诊断**：
```bash
ssh oracle
docker logs rop-analytics-analytics-api-1 --since 1h | grep -iE 'clover|401|unauthorized'
```

**根因**：Clover access token 对于未授权商户 app 是短期的。它会周期性过期，任何还持有旧值的服务在下次 API 调用时就 401。

**修复**：
1. 在 Clover dashboard 轮换 token。
2. 在 Infisical `prod` scope 更新 `CLOVER_TOKEN`（一个 secret，kds 和 analytics 都经 `with-infisical` 读它）。backoffice 不直接读取。
3. 重启 kds + analytics stack 让 `with-infisical` 重新注入：`docker compose -f compose/kds.yml --env-file compose/kds.env up -d`（`analytics` 同理）。

没有应用内轮换 UI —— 这是刻意的。之前的 `/api/clover/token-mode` 端点已移除；env 来源的 token 活在 Infisical（KDS 稳态 token 也以 Backoffice 保存的加密 DB row 形式存在 —— 见 §7.1）。

### 6.4 CI 抓到的 compose 校验

**症状**：`Validate compose stacks` 检查（`validate-compose.yml`）失败 —— `docker compose config failed for compose/<stack>.yml`。

这是个**结构性**检查：它解析 YAML、解析 merge，并验证每个服务引用的 network/volume 都已定义。它**不**对任何外部存储校验 env 值（旧的 Dokploy env-drift 校验器随 Dokploy 一起删了）。典型原因：

- **坏 YAML** —— 缩进、重复 key、写坏的 `${VAR:-default}`。
- **未定义的 network/volume** —— 某服务的块里列了一个 network/volume，但文件底部没声明（例如你在 `rop-net` 上加了个服务、却忘了顶层的 `networks: rop-net: {external: true}`）。

未设的 `${VAR}` 只 warn —— 它们在部署时从主机 `.env` / Infisical 来，不来自 CI。改 YAML 推上去；检查会在 PR 上重跑。

### 6.5 Traefik 404 / 路由没被识别

```bash
# router 注册了吗？
ssh oracle "curl -s http://127.0.0.1:8080/api/http/routers | jq '.[].name' | grep rop"

# 容器在 rop-net 上吗？
ssh oracle "docker inspect <container> | jq '.[0].NetworkSettings.Networks | keys'"

# labels 符合预期吗（含 traefik.docker.network=rop-net）？
ssh oracle "docker inspect <container> | jq '.[0].Config.Labels' | grep traefik"
```

最常见原因：已路由的服务漏了 `traefik.docker.network=rop-net` label，于是 Traefik 去它的 provider 默认网络（`traefik-servicenet`）上找后端，而不是容器实际所在的扁平 `rop-net` bridge。补上 label，推，redeploy。

### 6.6 WebAuthn / passkey 失败

WebAuthn 要求：
1. HTTPS（除了 `localhost` 开发用，不能用 HTTP）。
2. `WEBAUTHN_RP_ID` 必须**精确**等于浏览器主机名（是 `kds.example.com`，不是 `kds.example.com:443`）。
3. 浏览器支持 WebAuthn（现代浏览器全部 + iOS 16+）。

如果换域名后用户报"passkey 无效"：RP ID 在注册时和凭据绑死。旧 passkey 在新域名上失效；用户必须重新注册。**没有**迁移路径 — 改域名前要按这个前提规划。

### 6.7 容器被 OOM kill

```bash
docker inspect <container> | jq '.[0].State.OOMKilled'   # true 即 OOM
```

Oracle ARM 24 GB。可观测性栈起来后工作集通常 ~6-8 GB。看到 OOM 检查：
1. **app 内存泄漏** — Grafana 看 Node `process_resident_memory_bytes` 时间线。
2. **主机 build cache 撑满** — `du -sh /home/actions-runner/buildx-cache/*`。清理：`docker buildx prune`。
3. **同租户吃内存** — `docker stats --no-stream`。

最后手段：给 compose 服务加 `deploy.resources.limits.memory`，让它快速失败而不是 OOM 拖死主机。

### 6.8 Daily reset 没跑

KDS 的 `DAILY_RESET_*` env 控制每晚清理陈旧 ticket（在 `DAILY_RESET_TIMEZONE` 的 `DAILY_RESET_HOUR:DAILY_RESET_MINUTE`）。如果没跑：
1. 看 `kds-worker` 在预期时间附近的日志：`docker logs rop-kds-kds-worker-1 --since 12h | grep -i reset`。
2. 确认 kds stack 的 `DAILY_RESET_ENABLED=true`（Infisical `prod`，或 kds 主机 `.env` / compose 默认值）。
3. Reset 每 `DAILY_RESET_CHECK_INTERVAL_MS`（默认 30 秒）检查一次。如果到时间 worker 是关的，**不会**事后补跑 — 在 backoffice 的 `/admin/reset` 页面手动触发一次。

---

## 7. 安全与密钥

### 7.1 各 secret 存放位置

运行时 secret 遵循 [ADR-0020](docs/decisions/0020-adopt-infisical-for-runtime-secrets.md) 的**三层模型**。本节是 `README.md` 链接过来的权威参考。

- **第 1 层 — Infisical（运行时注入）。** 稳态应用 secret 存在 `restaurant-ops-platform` Infisical 项目（`prod` 环境），容器启动时由 `with-infisical` 入口包装脚本（[`scripts/with-infisical.sh`](scripts/with-infisical.sh)）注入进程环境 —— 不落盘 `.env`，应用代码仍通过现有 zod schema 读 `process.env`（`lib/env.ts` / `src/config.ts` 不变）。成员：`CLOVER_*`、`CLOVER_WEBHOOK_AUTH_CODE`、`INVENTORY_INTERNAL_TOKEN`、`CREW_*`、`ANALYTICS_ADMIN_TOKEN` / `ADMIN_TOKEN`、`REDIS_URL`、`WEB_LOGIN_PASSWORD_HASH`。
- **第 2 层 — `app_setting` AES-GCM 行。** 运维可轮换、可热重载的 secret（如 `ai.deepseek_api_key`）以加密行存在 `app_setting`（ADR-0016/0017），管理员在 `/settings/ai` 重新保存即可，无需 redeploy。Infisical **不**取代这一层 —— 两者互补。
- **第 3 层 — 主机 `.env` 文件 + 1Password（bootstrap / 破窗 / secret zero）。** Infisical 自己注入不了的不可约集合：本地 DNS infra URL（`DATABASE_URL`、`REDIS_URL`、`INVENTORY_DATABASE_URL`）、`POSTGRES_PASSWORD`，以及解锁第 1 层的 Infisical 机器凭据本身（"secret zero"，`INFISICAL_MACHINE_CLIENT_ID` / `INFISICAL_MACHINE_CLIENT_SECRET`）。这些活在被 gitignore 的各 stack 主机文件 `compose/<stack>.env`（模板：[`.env.prod.example`](.env.prod.example)），并在 1Password 备份。Prisma migrate sidecar 在应用之前跑，不能依赖 Infisical fetch —— 所以 DB URL 留在 env。**覆盖规则**（§2.7）：`with-infisical` 启动时覆盖同名 env，所以 infra URL 必须留在这里、**不**放进 Infisical，否则 Infisical 里（可能陈旧的）值会赢。
- **CI / 部署控制面**（`ORACLE_SSH_KEY`、`ORACLE_SSH_HOST`、`SENTRY_AUTH_TOKEN`、`SLACK_WEBHOOK_URL`）留在 **GitHub Actions secrets**（从 1Password `Example Kitchen DevOps` 保险柜镜像），这样部署不会循环依赖 Infisical fetch 是否成功。

本地 AI agent 和运维命令的第 3 层 / 控制面 secret 仍以 **1Password** 为源头，见 [`docs/agent-secret-workflow.md`](docs/agent-secret-workflow.md)；第 1 层运行时 secret 走 Infisical（本地 `infisical login` + `SECRETS_BACKEND=infisical make dev`，agent / CI 用只读、`dev`-scoped 的 Infisical 机器身份 / MCP）：

```bash
op run --env-file=.env.tpl -- claude
op run --env-file=.env.tpl -- codex
op run --env-file=.env.tpl -- scripts/sync-github-secrets-from-agent-env.sh
```

| Secret | 位置 | 用户 |
|---|---|---|
| `CLOVER_TOKEN`、`CLOVER_*` 凭据 | **第 1 层** — env 来源的凭据走 Infisical（`with-infisical`，bootstrap/fallback + analytics-api）；KDS 稳态走 Backoffice 保存的加密 DB row | kds-api、kds-worker、analytics-api；inventory-api（仅 `CLOVER_MERCHANT_ID` 范围，用于 ADR-0028 sold-items feed） |
| `CLOVER_WEBHOOK_AUTH_CODE` | **第 1 层** — Infisical（`with-infisical`） | kds-api webhook 校验 |
| `INVENTORY_INTERNAL_TOKEN` | **第 1 层** — Infisical（`with-infisical`） | backoffice BFF ↔ inventory-api bearer |
| `CREW_SESSION_SECRET`、`CREW_PIN_PEPPER`（`CREW_*`） | **第 1 层** — Infisical（`with-infisical`） | inventory-api crew PIN 登录 |
| `REDIS_URL` | **第 1 层** — Infisical（`with-infisical`） | kds-api、kds-worker、backoffice |
| `ANALYTICS_ADMIN_TOKEN` / `ADMIN_TOKEN` | **第 1 层** — Infisical，两个消费方读同一个 secret（**相同**值） | backoffice ↔ analytics-api bearer 认证 |
| `WEB_LOGIN_PASSWORD_HASH`（可选兜底） | **第 1 层** — Infisical（`with-infisical`） | Argon2id 密码登录 |
| `DEEPSEEK_API_KEY`（`ai.deepseek_api_key`）及其它 `category=secret` 行 | **第 2 层** — `app_setting` AES-GCM 行（`category=secret`），在 `/settings/ai` 设置/轮换；`DEEPSEEK_API_KEY` env 是已弃用的过渡兜底 | backoffice AI 聊天路由（解析顺序：DB row 优先，然后 env，再 503）；未来 Clover OAuth token |
| `DATABASE_URL`、`INVENTORY_DATABASE_URL` | **第 3 层** — 主机 `.env`（`compose/<stack>.env`；本地 compose DNS；按覆盖规则别放进 Infisical；1Password 备份） | 所有 app；第二个 URL 归 inventory-api |
| `REDIS_URL`（infra-URL 形式） | **第 3 层** — 主机 `.env`（`redis://redis-kds:6379`，本地 compose DNS） | kds-api、kds-worker、backoffice —— 见下方覆盖规则说明 |
| `POSTGRES_PASSWORD` | **第 3 层** — 主机 `.env`（全新命名卷；不对网络暴露） | 各 stack 的 `postgres-*` compose 服务 |
| `SESSION_SECRET`（kds 和 backoffice 用**不同**的值） | **第 1 层** — Infisical（`with-infisical`）；1Password 备份 | Cookie 签名 |
| `KDS_INTERNAL_ADMIN_TOKEN` | **第 1 层** — Infisical（kds 和 backoffice 用**相同**值） | backoffice ↔ kds-api bearer 认证 |
| `AI_TOKEN_ENCRYPTION_KEY` | **第 1 层** — Infisical（仅 kds-api；1Password 破窗副本） | db-kds 里 POS provider token 落盘加密的主密钥 —— `clover_merchants.*Cipher`、`pos_accounts.*Cipher`，以及 Deliverect 的 `kds_provider_configs.{apiToken,hmacSecret}Cipher`（PR #750/#761，Phase 4.5）。仅 kds-api/kds-worker 经 `src/lib/crypto/encryption.ts` 读取；backoffice 的 `app_setting` 用**另一把** `APP_SETTING_ENCRYPTION_KEY`（泄露一把不连累另一把）。kds-api 启动时若未设会 fail-fast（`assertAiTokenEncryptionKey`）。从不用于 AI 助手。丢失 = 每行加密 token 读不出来，运维重新授权 POS 连接。 |
| `APP_SETTING_ENCRYPTION_KEY` | **第 1 层** — Infisical（仅 backoffice） | `app_setting` 中 `category=secret` 行（AI provider API key 含 `ai.deepseek_api_key`、未来 Clover OAuth token）at-rest 加密的主密钥。32 字节 hex（`openssl rand -hex 32`）。与 `AI_TOKEN_ENCRYPTION_KEY` 不同，泄露一个不连累另一个。丢失 = 每行 secret setting 读不出来，运维在 `/settings/ai` 重新录入。见 issue #244。 |
| `APP_SETTING_ENCRYPTION_KEY_PREVIOUS` | **第 1 层** — Infisical（仅 backoffice，临时） | 轮换 `APP_SETTING_ENCRYPTION_KEY` 时的只解密兜底。所有 secret row 在新主密钥下重写后，下次重启删掉。 |
| `INFISICAL_MACHINE_CLIENT_ID` / `INFISICAL_MACHINE_CLIENT_SECRET` —— **"secret zero"** | **第 3 层** — 主机 `.env`（1Password 备份） | `with-infisical` 为每个消费服务拉取第 1 层时用的 Universal Auth 机器身份（`Claude`）。旧的静态 `INFISICAL_TOKEN` 已撤销 —— 留空。Project/env（`prod`）/path 默认值烤进了 `with-infisical.sh`。 |
| `ORACLE_SSH_KEY` / `ORACLE_SSH_HOST` | **控制面** — 1Password `Example Kitchen DevOps` 为源头；GitHub repo secrets 为镜像 | `build-images.yml` 部署步骤（SSH → `scripts/deploy-stack.sh`） |
| `SENTRY_AUTH_TOKEN`、`SENTRY_ORG` | **控制面** — GitHub repo secrets | `build-images.yml`（构建镜像时上传 Sentry source-map / release） |
| `SLACK_WEBHOOK_URL` | **控制面** — GitHub repo secrets | `slack-notify.yml` |
| `GRAFANA_ADMIN_PASSWORD` | Oracle 上的 `~/.env.observability`（root 可读） | 可观测性 compose |
| Oracle 部署 + 运维 SSH key | 部署 key 在 GH secret `ORACLE_SSH_KEY`；运维 key 在本地 `~/.ssh/` | CI 部署 + 紧急 SSH |

1Password 是运维保险柜和破窗备份，不是生产运行时依赖。GitHub Actions 读 GitHub repo secrets。在主机上，每个 stack：**第 3 层**从它的 `compose/<stack>.env` 文件读，**第 1 层**经 `with-infisical` 入口从 Infisical 读（用那个 `.env` 里的 secret-zero 机器身份），**第 2 层**从应用数据库读。主机只持有启动服务所需的那一个 scoped、可撤销的 Infisical 凭据，而不是宽权限的 1Password 凭据。

### 7.2 轮换流程

| Secret | 频率 | 步骤 |
|---|---|---|
| `SESSION_SECRET`（第 1 层） | 仅在事故后 | 在 Infisical（`prod`）轮换 → 重启 kds + backoffice 让 `with-infisical` 重新注入 → 所有用户被迫重登 |
| `CLOVER_TOKEN`（第 1 层） | 跟 Clover 政策轮换 | 在 Infisical（`prod`）更新该 secret，然后重启消费方让 `with-infisical` 重新注入；Clover 侧流程见 §6.3 |
| `ANALYTICS_ADMIN_TOKEN` / `ADMIN_TOKEN`（第 1 层） | 每年 | **在 Infisical 轮换一次**，然后重启 analytics-api + backoffice。byte-identical 的 compose 重复已消除（ADR-0020）—— 共享值是单个 Infisical secret，不再有错峰 401 的风险。 |
| `KDS_INTERNAL_ADMIN_TOKEN`（第 1 层） | 每年 | **在 Infisical 轮换一次**（kds + backoffice 读同一个值），然后两个 stack 都重启。一个 Infisical secret，没有错峰 401 风险。 |
| Infisical "secret zero" —— `INFISICAL_MACHINE_CLIENT_ID` / `_SECRET`（第 3 层） | 每年或笔记本丢失后 | Infisical → Access Control → Machine Identities → 轮换 `Claude` 身份的 client secret，更新每个 stack 主机 `compose/<stack>.env` 里的 `INFISICAL_MACHINE_CLIENT_*`，重启。窗口期内各 stack 新旧混用无害（只读 fetch）。 |
| `ORACLE_SSH_KEY`（控制面） | 每年或笔记本丢失后 | 生成新密钥对，把公钥加到主机 `~/.ssh/authorized_keys`，更新 `ORACLE_SSH_KEY` GH repo secret，验证一次部署能用，再删旧公钥 |
| `AI_TOKEN_ENCRYPTION_KEY`（第 1 层） | 仅在事故后 | 手动流程：在 Infisical 把新 key 设为 `AI_TOKEN_ENCRYPTION_KEY_NEXT`，跑一次性 re-encrypt 脚本遍历落盘 token 表（`kds_provider_configs`、`pos_accounts`、`clover_merchants`），切换 Infisical 值，删旧 key。脚本目前没写；真要轮换时写一个并记在这里（见 `docs/audits/2026-06-18-secret-management-audit.md` P2-3 / P3-1）。 |
| `APP_SETTING_ENCRYPTION_KEY`（第 1 层） | 仅在事故后 | 双密钥过渡（issue #244）：`openssl rand -hex 32` 生成，在 Infisical 把旧 key 移到 `APP_SETTING_ENCRYPTION_KEY_PREVIOUS`，把新 key 设为 `APP_SETTING_ENCRYPTION_KEY`，重启 backoffice。打开 `/settings/ai` 重新保存每个 `category=secret` 行（writer 在新 key 下重新加密）。下次重启删掉 `APP_SETTING_ENCRYPTION_KEY_PREVIOUS`。 |
| Oracle 运维 SSH key | 每年 | 新公钥先加到 `~/.ssh/authorized_keys`；验证新 key 能用；再删旧的 |

### 7.3 分支保护

见 [`.github/BRANCH_PROTECTION.md`](.github/BRANCH_PROTECTION.md)。核心不变量：
- `main` 必须通过绿色 PR 才能更新。
- Status checks `Lint, build, test` + `E2E + migrations` 必须绿。
- Linear history（没有 merge commits）— 保 `git log` 干净，回滚不歧义。
- 新推送 dismiss stale approval。

仓库 owner 可以紧急 admin-bypass，但每次 bypass 之后理想做法是补一个 PR 把当时会抓住这个问题的测试加上。

### 7.4 事故响应骨架

1. **遏制**：别部署。部署本来就仅手动触发（ADR-0014），所以只要不跑 `build-images.yml` 就停住了任何新滚动；如果某个 stack 正在作妖，在主机上停掉它（`docker compose -f compose/<stack>.yml down`）。
2. **诊断**：Sentry + Grafana Loki + 最近 git log。
3. **必要时回滚**：见 §4.7。
4. **轮换被暴露的 secret**：见 §7.2。
5. **在 `HANDOFF.md` 里写复盘** — 记在 HANDOFF.md「Operational log」一节；更早的范例见 docs/archive/HANDOFF-phase-closeouts.md。
6. **加测试或告警**让下次能更早抓到（参考 §5.4 已有模式）。

---

## 8. 灾备与备份

### 8.1 当前备份现状（缺口）

| 资产 | 备份了吗？ | 在哪 | 测过恢复？ |
|---|---|---|---|
| `postgres-kds-data` 卷 | ❌ 没定时备份 | n/a | n/a |
| `postgres-analytics-data` 卷 | ❌ 没定时备份 | n/a | n/a |
| `postgres-inventory-data` 卷 | ❌ 没定时备份 | n/a | n/a |
| `redis-kds-data`（只放 session） | ❌ 不备份（短暂数据） | n/a | n/a |
| GHCR 镜像 | ✅ 默认 90 天保留 | `ghcr.io/example-org/rop-*` | ✅ 通过钉镜像（§4.7） |
| `compose/*.yml` | ✅ 在 git | repo | ✅ 通过 §4.7 |
| 运行时 secret | ✅ Infisical `prod` scope（托管服务） | Infisical | ⚠️ 依赖 Infisical 自身的持久性 |
| 主机 `.env` 文件（`compose/*.env`：secret-zero + infra URL） | ⚠️ 只在 Oracle 主机文件系统；1Password 存 secret-zero | 主机 + 1Password | ❌ 从未恢复过 |
| `.env.observability` | ⚠️ 只在 Oracle 主机文件系统 | `~/.env.observability` | ❌ 从未恢复过 |
| 源代码 | ✅ GitHub | n/a | ✅ |

**下一步建议**：
1. 开 Backblaze B2 / Cloudflare R2 bucket。
2. 加一个主机 cron，对每个 `postgres-*` 服务（经 `docker exec`）`pg_dump` 并上传到 bucket。
3. 每个 DB 排期：每日 03:00 UTC，保留 30 天。
4. 设好后 7 天内**测一次恢复**，之后每季度。**没测过的备份等于没备份**。

### 8.2 镜像回滚

§4.7 已涵盖。在主机上钉 SHA（或在 `main` revert + 重新部署）。被覆盖的 `:main` 标签找不回来，但 `:<sha>` 在 GHCR 里保留 90 天。

### 8.3 数据库备份/恢复演练（实现后）

建议演练（每 90 天）：
1. `pg_dump` 线上 DB：`ssh oracle 'docker exec rop-kds-postgres-kds-1 pg_dump -U postgres rop_kds' > /tmp/kds.sql`。
2. 恢复到一个一次性的废用 Postgres 容器（`docker run --rm postgres:16-alpine` + `psql < /tmp/kds.sql`）。
3. 对 `mart.sales_daily_mv`、`kds_tickets`、`clover_merchants` 跑冒烟 SQL — 检查行数 + 几个采样查询。
4. 拆掉一次性容器。在 `HANDOFF.md` 记录日期。

### 8.4 某个 stack 挂了（没有控制面会挂）

不再有控制面 —— stack 就是 plain `docker compose`，所以故障模式就是 Docker 自己的那些：

1. **容器各自独立在跑** —— 没有它们依赖的 daemon；某个 stack 卡住了，别的不受影响。
2. **重启一个 stack**：`ssh oracle 'cd ~/restaurant-ops-platform && docker compose -f compose/<stack>.yml --env-file compose/<stack>.env up -d'`。
3. **从头重建**（例如手动 `down` 之后）：同一条命令 —— compose 重建容器；命名卷（及其数据）保留。
4. **验证**：`ssh oracle 'docker compose -f compose/<stack>.yml ps'` 以及 §2.11 的冒烟 curl。

经 CI 部署需要 Mac Mini runner + SSH 可达；如果 CI 不可用，在主机上用 `scripts/deploy-stack.sh <stack>` 手动部署。

### 8.5 整台主机丢失

最坏情况：Oracle 把实例销了。

1. **开新 Oracle ARM 实例**，同 shape。
2. **装 Docker + clone 仓库**到 `~/restaurant-ops-platform`（§2.2），并**创建外部网络** `rop-net`（§2.4）。
3. **从备份恢复 DB 数据**到新的命名卷（`pg_dump`/`psql`，或卷恢复），在 `postgres-*` 服务起来之后。
4. **重建主机 `.env` 文件**（`compose/<stack>.env`），从 [`.env.prod.example`](.env.prod.example) 模板 —— 填上从 1Password 来的 Infisical secret-zero（`INFISICAL_MACHINE_CLIENT_ID` / `_SECRET`）和 infra URL。其余一切启动时从 Infisical 重新注入。
5. **拉起每个 stack**：对 `kds`、`analytics`、`backoffice`、`inventory`、`crew`、`order`、`legal`、`marketing` 跑 `bash ~/restaurant-ops-platform/scripts/deploy-stack.sh <stack>`（crm staged）。
6. **重发 Cloudflare DNS A 记录**指向新 IP。
7. **重新指向部署 secret**：更新 `ORACLE_SSH_HOST`（以及主机的 `authorized_keys` 给 `ORACLE_SSH_KEY`）；如果自托管 runner 在丢的那台机器上，**重装自托管 runner**（§2.9），用新 runner token。
8. **重装可观测性栈**（§5.1）— 接受历史 metric / 错误丢失，除非你也备了那几个卷。

**RTO**（恢复时间目标）当前备份姿态下：~半天，OLTP 和 OLAP DB 有显著数据丢失（看最新备份时刻）。补 §8.1 缺口能大幅改善。

---

## 9. 附录

### 9.1 端口 / 域名 / 网络索引

| 域名 | Compose 服务 | 容器端口 | 认证 |
|---|---|---|---|
| `kds.example.com` | kds-api (`/api`, `/ws`, `/admin`) + kds-web（兜底） | 4000 / 3000 | Cookie session + WebAuthn |
| `analytics.example.com` | analytics-api (`/webhooks/clover`, `/admin`) | 3100 | Bearer（admin 端点）+ Clover 签名（webhook） |
| `backoffice.example.com` | backoffice-web | 3001 | Cookie session + WebAuthn |
| `inventory.example.com` | inventory-api | 4100 | Bearer / crew PIN（内部；经 BFF） |
| `crew.example.com` | crew-web | 3003 | Crew PIN session |
| `order.example.com` | order-web | 3004 | 公开（顾客） |
| `legal.example.com` | legal-site | 80 | 公开 |
| `www.example.com` | marketing-site | 80 | 公开 |
| `metrics.example.com` | grafana | 3000 | 账号 |

### 9.2 环境变量索引

按 stack 看各自的 `.env.example`：
- 全套：[`.env.example`](.env.example)
- 生产主机 bootstrap（各 stack 的 `.env`）：[`.env.prod.example`](.env.prod.example)
- Analytics：[`apps/analytics-api/.env.example`](apps/analytics-api/.env.example)
- Backoffice：[`apps/backoffice-web/.env.example`](apps/backoffice-web/.env.example)
- 可观测性：[`.env.observability.example`](.env.observability.example)

每个 stack **runtime 必填**的权威列表是各自 [`compose/*.yml`](compose/) 里的 `environment:` 块 — 没有 `${VAR:-default}` 默认值的就是必填（部署时从 Infisical 或主机 `.env` 来）。

### 9.3 常用命令

```bash
# 看一个 stack 的服务（plain compose 名：rop-<stack>-<service>-<n>）
ssh oracle "docker ps --filter 'label=com.docker.compose.project=rop-kds' --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'"

# 跟踪 kds 所有服务的日志（按 compose 服务名）
ssh oracle "cd ~/restaurant-ops-platform && docker compose -f compose/kds.yml logs -f --tail 50"

# 进 kds DB 的 Postgres shell
ssh oracle "docker exec -it rop-kds-postgres-kds-1 psql -U postgres rop_kds"

# Redis ping
ssh oracle "docker exec rop-kds-redis-kds-1 redis-cli ping"

# 手动部署 / re-up 单个 stack（先 git-sync 到 origin/main）
ssh oracle "bash ~/restaurant-ops-platform/scripts/deploy-stack.sh kds"

# 手动跑一次业务健康检查（不发邮件）
ssh oracle "$HOME/restaurant-ops-platform/scripts/check-business-health.sh --dry-run"

# 推送前本地跑 compose 校验（和 CI 同一个检查）
for f in compose/*.yml; do docker compose -f "$f" config -q && echo "$f ✓"; done
```

### 9.4 相关文档

| 文档 | 焦点 |
|---|---|
| [`AGENTS.md`](AGENTS.md) | 仓库约定、铁律、各 app 边界、"Deploy is user-gated" |
| [`docs/decisions/0005-dokploy-over-coolify.md`](docs/decisions/0005-dokploy-over-coolify.md) | 已被取代的"采用 Dokploy"决定（保留作历史；见 Dokploy-removal ADR） |
| [`.github/OBSERVABILITY.md`](.github/OBSERVABILITY.md) | 可观测性栈细节 |
| [`.github/BRANCH_PROTECTION.md`](.github/BRANCH_PROTECTION.md) | 分支保护设置 |
| [`compose/README.md`](compose/README.md) | Compose stack 概览 |
| [`.env.prod.example`](.env.prod.example) | 各 stack 的生产主机 `.env` 模板（secret-zero + infra URL） |
| [`scripts/deploy-stack.sh`](scripts/deploy-stack.sh) | 主机部署脚本（git-sync + `docker compose pull && up -d`） |
| [`infrastructure/traefik/README.md`](infrastructure/traefik/README.md) | Traefik 动态配置（Clover webhook fan-out） |
| `HANDOFF.md` | 当前 handoff：生产现状、未结线索、运行日志（阶段历史见 `docs/archive/HANDOFF-phase-closeouts.md`） |
| `HANDOFF-clover-webhook-fanout.md` | Webhook fan-out 部署记录 |
| [`README.md`](README.md) | 快速开始（本地开发）+ 集成说明 |

---

> 发现错或缺什么？直接改这个文件。英文版 [`OPERATIONS.md`](OPERATIONS.md) 应该在同一个 PR 里同步更新。
