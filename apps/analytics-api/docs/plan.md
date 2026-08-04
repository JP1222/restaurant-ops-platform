# PRD：Example Kitchen 套件——Backoffice & Analytics 系统

> **Status:** historical — the PRD shipped across Phases 1–7 (the "v3 草稿，等待审批" header below is the point-in-time record, not the live verdict).

> 状态：**v3 草稿，等待审批**
> v3 关键变更：从"Analytics 独立产品"升级为"restaurant-ops-platform 统一套件"，把 KDS / Analytics / 未来的 Inventory 整合在一个 monorepo 中，新建一个统一 backoffice-web，承载 Analytics + KDS 管理 + Inventory 管理。
> 视角：产品经理 + UX 设计师 + 软件架构师三合一。

---

## 0. 阅读指引

文档分四块：

1. **架构基石**（§1–§4）—— 套件架构、Floor vs Backoffice 切分、设计系统、调研结论
2. **Backoffice 产品规格**（§5–§9）—— 页面、API、AI 浮窗
3. **工程方案**（§10–§13）—— Monorepo 结构、部署、Auth、CLAUDE.md
4. **实施计划**（§14–§17）—— 分阶段、并行轨道、风险、验收

---

## 1. 项目背景与现状

你正在构建一套面向单店餐厅的软件套件，已建/在建/待建：

| 系统 | 状态 | 仓库 | 角色 |
|---|---|---|---|
| **KDS**（Kitchen Display System） | ✅ 已上线 | `restaurant-ops-platform-KDS`（原独立仓库，已并入本 monorepo） | 厨房/餐厅 TV 订单显示 + iOS 原生 |
| **Intelligence**（数据管道） | ✅ 后端已上线 | `restaurant-ops-platform-Intelligence`（原独立仓库，已并入本 monorepo） | Clover → mart 星型仓库 |
| **Analytics**（业务分析 UI） | 🟡 现在要做 | （拟合并） | 餐厅老板分析视图 |
| **Inventory** | ⏳ 未来要做 | （拟合并） | 库存管理 |

**KDS 的现状（关键）**：

- pnpm monorepo: `apps/{web,api}` + `packages/{contracts,db}` + iOS
- 后端：Fastify + Prisma + Postgres + Redis + BullMQ
- 前端：Next.js 16 + React 19 + **纯 CSS（不是 Tailwind）** + 自定义组件
- 认证：**Passkey (WebAuthn) + Argon2id 兜底 + cookie session**（远比 Intelligence 的 ADMIN_TOKEN 高级）
- 设计系统：纸张白 #f6f0e6 + 番茄红 #c54d2a + 琥珀 #c38a1d + 薄荷绿 #2d8b63 + 石板 #3f4b5c，Space Grotesk + IBM Plex Sans，胶囊按钮，毛玻璃面板，无暗色模式
- 部署：Docker + Traefik（外部网络 `traefik-servicenet`），域名 `kds.example.com`

**Intelligence 的现状（关键）**：

- 单仓库，单 package
- Node 原生 http server（不是 Fastify） + 原生 SQL（不是 Prisma） + zod + Luxon
- 数据：Postgres 16 + 星型 schema（`mart.fact_*`、`mart.dim_*`、`mart.sales_*_mv`）
- 已有"AI 友好"沙箱 [src/analytics/safe-query.ts](../src/analytics/safe-query.ts)
- 旧 admin dashboard 是原生 HTML/JS（[src/http/dashboard.ts](../src/http/dashboard.ts)），用 ADMIN_TOKEN

---

## 2. 架构基石：Floor 产品 vs Backoffice 产品

这是整份 PRD 的灵魂。餐厅 SaaS 业界（Toast / Square for Restaurants / Lightspeed）有一个清晰的产品切分：

| 维度 | **Floor 产品** | **Backoffice 产品** |
|---|---|---|
| 用户 | 厨师、收银、服务员、客人 | 老板、店长、运营 |
| 设备 | TV、平板、收银机、客显 | 桌面浏览器、手机 |
| UX 目标 | 极简、大字、触屏、不思考即可用 | 信息密度、键鼠精准、深度分析 |
| 错误成本 | 即时影响业务（点错单子） | 仅影响决策 |
| 刷新频率 | 实时 / 秒级 | 分钟级 / 静默 |
| 颜色策略 | 高对比、明亮 | 中性、可读 |

**KDS 的 board / customer-display 是 Floor 产品。Analytics + KDS Admin + 未来 Inventory 是 Backoffice 产品。**

**结论：不要把 Analytics 当独立 Web，而是把它当 Backoffice 的一个 Section**。

```
┌──────────────────────┐    ┌──────────────────────┐
│   KDS Floor          │    │   Backoffice         │
│   kds.example.com       │    │   app.example.com       │
│                      │    │                      │
│   ✋ 不动            │    │   👨‍💻 现在要做       │
│                      │    │                      │
│   • Board (厨房 TV)  │    │   • Analytics ★      │
│   • Customer Display │    │   • KDS Admin ★      │
│   • POS Login        │    │   • Inventory (未来) │
│                      │    │   • Operations       │
└──────────────────────┘    │   • AI Assistant     │
                            └──────────────────────┘
                                 ↑                 ↑
                            合并自 KDS 现有 admin   合并自 Intelligence 现有 admin
```

**用户的反馈强约束**：
- ✅ Board 页面、Customer Display 页面**不动**（floor 产品不该被分析需求干扰）
- ✅ Board 页面**的设置 UI** 可以迁移到 Backoffice
- ✅ KDS 的 admin 后台页面**可以**与 Analytics dashboard 合并

---

## 3. 仓库架构决定：统一 Monorepo（Option C）

**新仓库**：`restaurant-ops-platform`（由 `restaurant-ops-platform-KDS` 重命名 / 扩展，保留 git 历史）

```
restaurant-ops-platform/
├── apps/
│   ├── kds-web/             ← 移自 restaurant-ops-platform-KDS/apps/web，UI 完全不动
│   ├── kds-api/             ← 移自 restaurant-ops-platform-KDS/apps/api，不动
│   ├── backoffice-web/      ← 新建：Next.js 15 App Router (Analytics + KDS Admin + 未来 Inventory)
│   ├── analytics-api/       ← 移自 restaurant-ops-platform-Intelligence/src，保持原有 Node http + raw SQL 风格
│   └── inventory-api/       ← 未来
├── packages/
│   ├── auth/                ← 抽自 KDS：passkey/WebAuthn + Argon2id + cookie session 库
│   ├── contracts/           ← 共享 zod schemas（已存在 KDS 的 packages/contracts，扩展）
│   ├── db-kds/              ← KDS 专属 Prisma schema + client（原 packages/db 改名）
│   ├── db-analytics/        ← Analytics 专属（如果 Analytics 也用 Prisma）；或继续 raw SQL，不创建此 package
│   └── deploy/              ← Docker + Traefik 模板（可选，工具脚本）
├── ios/                     ← 现有 KDS iOS 应用，不动
├── scripts/                 ← deploy / dev / health-check（合并）
├── docs/
├── docker-compose.yml       ← 扩展：增加 backoffice-web、analytics-api 服务
├── pnpm-workspace.yaml      ← 包含所有 apps/ 和 packages/
└── CLAUDE.md                ← 顶层指南
```

**关键设计决定**：
- 三套 API 各自有自己的 Postgres**（不强行合并）**：KDS 是 OLTP（实时订单），Analytics 是 OLAP（聚合查询），未来 Inventory 也是 OLTP。共享的只是 auth、ui、contracts、deploy。
- KDS 现有页面**完全不动**：board/customer-display/login 留在 `apps/kds-web/`。
- KDS 的 admin 设置页面**逐步迁移**到 `apps/backoffice-web/`，迁移完后从 `kds-web` 删除。
- Intelligence 后端代码整体迁入 `apps/analytics-api/`，保持现有 raw SQL + zod + Luxon 风格不动（不强求改造成 Fastify+Prisma，因为 OLAP 场景下 raw SQL 更合适）。

**为什么这是最佳时机**：
- KDS 已是 monorepo，扩容成本低
- Analytics 前端还没写，零成本融入
- Inventory 还未开始，享现成基础设施
- 任何延迟，迁移成本翻倍

---

## 4. 业界调研结论

我系统调研了 Toast、Square for Restaurants、Lightspeed、Oracle MICROS、Crunchtime、SpotOn、Quantic、DataGPT、Tinybird 等成熟产品。归纳如下：

### 4.1 业界共识的"餐厅必看分析维度"（按重要性）

| # | 维度 | 解决什么 | 我们能做吗 |
|---|---|---|---|
| 1 | Sales / Revenue | 营收、订单、客单价、净销售 | ✅ |
| 2 | Daypart（早午茶晚夜） | 哪个时段是顶梁柱 | ✅ |
| 3 | Day-of-Week pattern | 周二是不是真最差 | ✅ |
| 4 | Menu Mix / Item Performance | 哪个菜在拉动 | ✅ |
| 5 | Modifier Analytics | 客人爱加什么 | ✅ |
| 6 | Tender Mix | 现金/卡占比异常 | ✅ |
| 7 | Refund / Discount | 谁在打折/退款 | ✅ |
| 8 | Order Type | 堂食/外带/外送 | ✅ |
| 9 | Server Performance | 服务员客单价 | ✅ |
| 10 | Period Comparison | WoW / MoM / YoY | ✅ |
| 11 | Labor Cost | 人工成本占比 | ❌（无排班数据，v1 不做） |
| 12 | COGS / Inventory | 食材成本毛利 | ❌（v1 不做，留给 Inventory 系统） |
| 13 | Customer / Loyalty | 老客回头率 | ❌（v1 不做） |

### 4.2 Dashboard 设计的 5 条铁律

1. **每页 5–8 个核心指标**，不要全堆上去
2. **每个指标必须配对比基准**（同期/目标/4 周均值），孤立数字无意义
3. **图表选型对应分析意图**：
   - 比较 → 柱状图 / 横向条形
   - 趋势 → 折线 / sparkline
   - 时段密度 → 热力图
   - 占比 → 横向堆叠条（避免饼图）
4. **从摘要钻取到细节**（drill-down）
5. **静默后台刷新**，加更新指示器（"几秒前更新"）

### 4.3 AI 助手设计原则

来自 ThoughtSpot Sage、DataGPT、Tinybird 的经验：

1. **不只是浮窗**——每个图表/卡片旁边都有"Ask AI"按钮（带预填问题）
2. **AI 知道当前页面**——系统提示注入路由 + 选中筛选器
3. **工具调用对用户可见**——可折叠卡片显示工具名/参数/行数/耗时
4. **永远引用数据出处**——"Queried hourly_mv 2026-04-23 → 2026-04-30, 168 rows"
5. **优先 typed tools，兜底 SQL**——复用 [src/analytics/safe-query.ts](../src/analytics/safe-query.ts) 沙箱
6. **建议气泡按页面定制**

### 4.4 Heatmap 是嵌入还是独立页？

**强意见：嵌入**。研究 Crunchtime / Toast / Tableau 后的结论：热力图脱离上下文就是漂亮图，必须配数据范围、目标比较等。所以：
- **Dayparts 页**：嵌入小时×周几热力图作为核心可视
- **Menu 页 → 单品下钻面板**：嵌入该单品热力图
- **Trends 页**：嵌入日历式热力图（GitHub-style）
- **不单独成页**

---

## 5. Backoffice-Web 信息架构

Backoffice 是**未来所有 Inventory / 设置 / 分析的统一容器**。导航分组：

```
┌─────────────────────────────────────────────────────────┐
│  Example Kitchen Backoffice                       👤 user ▼  │
├──────────────┬──────────────────────────────────────────┤
│  Analytics   │                                          │
│  • Today     │           主内容区                        │
│  • Trends    │                                          │
│  • Compare   │                                          │
│  • Menu      │                                          │
│  • Dayparts  │                                          │
│              │                                          │
│  KDS Admin   │                                          │
│  • Board     │                                          │
│  • Devices   │                                          │
│  • Integr.   │                                          │
│  • Reset     │                                          │
│  • Users     │                                          │
│              │                                          │
│  Inventory   │                                          │
│  ⏳ (v2)     │                                          │
│              │                                          │
│  Operations  │                                          │
│  • Sync      │                                          │
│  • Jobs      │                              ╭──────╮    │
│  • DQ        │                              │  AI  │    │
│  • Backfill  │                              │ 浮窗 │    │
│              │                              ╰──────╯    │
└──────────────┴──────────────────────────────────────────┘
```

| 分组 | 页面 | 职责 | 数据源 |
|---|---|---|---|
| **Analytics** | Today, Trends, Compare, Menu, Dayparts | 业务分析（v1 主战场） | analytics-api |
| **KDS Admin** | Board Settings, Devices, Integrations, Daily Reset, Users & Passkeys | 从 KDS web 迁移过来 | kds-api |
| **Inventory** | （v2 未规划） | 库存管理 | inventory-api |
| **Operations** | Sync Health, Jobs & DQ, Backfill, Webhooks, Database | Intelligence 旧 admin 重做 | analytics-api |
| **AI Assistant** | 全局浮窗 | 跨域问答 | analytics-api 工具 + （未来 kds-api 工具） |

---

## 6. Backoffice-Web 页面规格

### 6.1 Analytics > Today（默认登录后落地页）

**用户故事**：早上 10 点老板到店，30 秒内想知道：今天生意如何？跟正常水平比有没有异常？

布局（从上到下）：

#### 区块 1：Hero KPI 条（4 张卡）

每卡：大数字 + 同 weekday 4 周均值对比百分比 + 红/绿箭头 + 7 天 sparkline

| KPI | 显示内容 |
|---|---|
| Net Sales | $4,238 ▲ 12% vs Tue avg |
| Orders | 87 ▼ 5% vs Tue avg |
| Avg Ticket | $48.71 ▲ 18% vs Tue avg |
| Refunds | $124 (2.9%) ▲ unusual |

#### 区块 2：Hourly Pulse（小时脉搏图，主图）

折线图，X = 0–23 本地小时，Y = 净销售：
- **实线**：今天小时累计
- **虚线**：过去 4 个相同 weekday 均值
- **半透明带**：±1σ 区间
- 悬停：该小时订单数、客单价、跟均值差距

附进度条："Sales pacing: 64% of typical day, 6 hours remaining"

#### 区块 3：Auto-Insights（自动洞察 2–4 张卡）

后端规则生成（v1 不用 LLM）：
- "Lunch hour (12pm) was 30% below your usual Tuesday lunch"
- "Refund rate is 2.9%, 2× your usual"
- "Top item Beef Bowl sold 18, normally sells 25 by this hour"

每张卡有"Ask AI →"按钮，点开浮窗预填问题。

#### 区块 4：Top 5 Items Today

横向条形图：菜名 + 销量 + vs 同 weekday 均值

#### 区块 5：This Week vs Last Week（缩略）

7 个柱子并排，每天一对（今周 vs 上周），点击跳 Compare 页预填该日。

**刷新**：60 秒静默 polling，右上角"Updated 12s ago"。

---

### 6.2 Analytics > Trends

**用户故事**：周日晚上想看过去一个月走势如何，有没有异常天。

控制条：日期范围（默认 30 天）+ 指标（Net Sales / Orders / AOV / Refund Rate）+ 粒度（Day / Week）

布局：
1. **Big Time Series**（折线 + 周末高亮 + 节假日标记）
2. **Calendar Heatmap**（GitHub-style 12 周，颜色 = 净销售，点天跳 Today 历史模式）
3. **Segment Breakdown**（3 tab：Order Type / Tender / Daypart 堆叠条）
4. **数据表**（每天一行，可下载 CSV）

---

### 6.3 Analytics > Compare

**用户故事**：月会上要汇报"本月每个周二 vs 上月每个周二"。

控制条（灵魂）：
```
[ Primary ▾ This Month ───── Apr 1 – Apr 30 ]
[ vs       ▾ Previous Month ─ Mar 1 – Mar 31 ]
[ Granularity ▾ Day | Hour | Week           ]
[ Metric ▾ Net Sales | Orders | AOV         ]
[ Breakdown ▾ None | Order Type | Daypart   ]
[ ⓘ Day-of-Week mode toggle                 ]
```

预设：This week vs Last week / Today vs Same weekday last week / Today vs 4-week same weekday avg / This month vs Last month / This month vs Same month last year / Custom

主区：
1. 大对比图（柱/折线根据粒度自动选）
2. Diff 数据表：每行一个时间桶，列 = 主期/对比期/绝对差/百分比差，条件格式
3. **Day-of-Week 特殊模式**：当主期跨多周时，渲染 7 行小图，每行一个 weekday，看"4 月 7 个周二"排排站

URL state：所有筛选反映在 query string，可分享。

---

### 6.4 Analytics > Menu

**用户故事**：老板想知道这一个月哪些菜在赚钱，哪些菜在白占菜单。

#### 区块 1：菜单工程象限图（Menu Engineering 2×2）

行业经典框架。横轴=销量百分位，纵轴=销售额百分位（v1 用销售额代理毛利，v2 接成本数据后改）：

| 高销额 + 高销量 = **Stars** ⭐ | 低销额 + 高销量 = **Plowhorses** 🐎 |
|---|---|
| 低销额 + 低销量 = **Dogs** 🐕 | 高销额 + 低销量 = **Puzzles** 🧩 |

每个菜一个气泡，气泡大小=出现频次。点气泡打开侧栏。

#### 区块 2：菜品数据表（TanStack Table）

列：图片占位 / 菜名 / 销量 / 净销售 / 客单贡献 / 退款率 / vs 上期 % / 趋势 sparkline。

功能：排序/搜索（含 alternate_name 别名）/ 多选 → 顶部"对比所选 N 个菜品"按钮 → 跳 Compare / 行点击 → 右侧抽屉打开下钻

#### 区块 3：单品下钻面板（右侧 Sheet）

- 头部：菜名 + 大数字（区间销量 / 营收）
- 时序图：每日销量
- **小时×周几热力图**（这里嵌入，不单独成页）
- Modifier 排行：最常加 / 最常去掉 Top 5
- 异常事件：哪些天没卖出 / 暴涨
- "Ask AI"按钮：预填"Tell me about [菜名] performance and any anomalies"

---

### 6.5 Analytics > Dayparts

**用户故事**：搞清楚自己店的"时间结构"——早午晚哪段顶梁柱、不同 weekday 高峰期分别在何时。

#### 区块 1：小时 × 周几 热力图（页面核心）

7 行 × 24 列，颜色 = 平均净销售。范围选择器（默认 30 天）。Cell 悬停=均值/标准差/样本，点击跳 Compare 预填。

#### 区块 2：Daypart 收入构成

Daypart 默认（写在 `apps/backoffice-web/lib/dayparts.ts` 可改）：
- Breakfast 6–10 / Lunch 11–14 / Snack 14–17 / Dinner 17–21 / Late 21–24

水平堆叠条（一行=一周）显示每个 daypart 占比。

#### 区块 3：Hour-of-Day 平均曲线（按 weekday 分色）

7 条折线叠加。一键切换"按 weekday 分组"vs"按 hour 分组"。"Best/Worst hour"自动标注。

---

### 6.6 KDS Admin（迁自 KDS web）

**只迁后台页面，不动 board/display。**

| 子页面 | 内容 | 来源 |
|---|---|---|
| **Board Settings** | 紧急度阈值、显示选项、自动重置 | KDS 现有 admin |
| **Devices** | 注册的 KDS 设备、配对码、最后心跳 | KDS 现有 admin |
| **Integrations** | Clover OAuth / Token 配置、Deliverect、Webhook | KDS 现有 `/admin/integrations/*` |
| **Daily Reset** | 重置时间、时区、启用/禁用 | KDS 现有 |
| **Users & Passkeys** | 添加/删除管理员、注册新 passkey、管理设备 | KDS 现有 auth |

**重要约束**：迁移完成前 KDS web 老 admin 保留可用，迁移完成后从 KDS web 删除入口。

---

### 6.7 Inventory（v2 占位）

Sidebar 显示一个"Coming soon"占位。v1 不实现。预留路由 `/inventory/*`。

---

### 6.8 Operations（运维）

替代 Intelligence 现有 [src/http/dashboard.ts](../src/http/dashboard.ts) HTML dashboard。Tabs：

| Tab | 内容 | 数据源 |
|---|---|---|
| Sync Health | 心跳、最后同步、滞后窗口 | analytics-api `/admin/api/overview` |
| Jobs | 最近 50 任务、失败、重试 | analytics-api `/admin/api/jobs` |
| Data Quality | DQ 失败、阈值告警 | 同上 |
| Backfill | 回填进度条 | analytics-api `/admin/api/overview` |
| Webhooks | Clover Webhook 验证 | analytics-api `/admin/webhook-verifications` |
| Database | mart 表行数、MV 刷新时间、磁盘 | 新查询 |

迁移完成后**删除** `src/http/dashboard.ts` 渲染 HTML 部分（517–993 行），保留 JSON API endpoint。

---

### 6.9 AI 助手（全局浮窗）

```
       ╭─────────────────────────────╮
       │  Example Kitchen AI Assistant      ✕   │
       ├─────────────────────────────┤
       │ 🤖 Hi! I see you're on the  │
       │    Today page. Ask me       │
       │    anything about your data │
       │                             │
       │  [Why was lunch slow?]      │
       │  [Top items today]          │
       │  [Compare to last week]     │
       │                             │
       │  ──── conversation ────     │
       │                             │
       │  user: Why was Tuesday bad? │
       │                             │
       │  🤖 Looking at this...      │
       │  ┌─ 🔍 compare_periods ─┐  │
       │  │ {primary: Tue Apr 28,│  │
       │  │  compare: 4-wk avg}  │  │
       │  │ → 87 orders vs 112 ▼ │  │
       │  └──────────────────────┘  │
       │  Tuesday's lunch (12-2pm)   │
       │  was the main drag, down    │
       │  35% from your usual...     │
       │                             │
       ├─────────────────────────────┤
       │ [Type your question......]  │
       │                       [↑]   │
       ╰─────────────────────────────╯
```

#### 关键 UX

- 全局右下角浮球（Lucide Sparkles）
- 桌面 400×600 浮窗，移动全屏 sheet
- **页面感知**：根据当前路由 + 筛选注入系统提示
- **建议气泡按页面**：每页 3 个预填问题
- **工具调用透明化**：可折叠卡片
- **引用数据出处**：内嵌"Queried xxx, N rows"
- **流式输出**：Vercel AI SDK `streamText`
- **Markdown 渲染**：表格 / 列表 / 代码 / 加粗
- **Inline 触发**：每图表 / 卡片旁有"Ask AI"按钮，预填"Explain this chart"
- **会话历史**：浮窗内可见上一条，**v1 关闭即清**
- **限速**：30 messages / hour / session
- **错误兜底**：工具失败友好降级，不暴露 SQL 报错

#### Tools（暴露给 LLM）

| 工具 | 输入 | 输出 | 实现 |
|---|---|---|---|
| `get_overview` | `{date?}` | 今日 KPI 摘要 + 同 weekday 均值 | mart.sales_daily_mv + sales_hourly_mv |
| `get_timeseries` | `{metric, grain, from, to}` | 时序数组 | 对应 MV |
| `compare_periods` | `{primary, compare, breakdown?}` | 双期对比表 | 组合查询 |
| `top_items` | `{from, to, by, limit}` | 单品排行 | mart.fact_order_line_items |
| `item_detail` | `{item_id, from, to}` | 单品时序 + 热力 + modifier | 多查询组合 |
| `daypart_breakdown` | `{from, to}` | 各 daypart 占比 | local_hour 分桶 |
| `weekday_pattern` | `{from, to, metric}` | 7 个 weekday 均值 | weekday 聚合 |
| `run_safe_query` | `{question, sql}` | 任意 SELECT | safe-query.ts 兜底 |

**优先级（写在系统提示）**：永远优先 typed tools，全都不适用才 fallback `run_safe_query`。

**v2 路线图**：暴露 `kds_*` 工具（如 `get_avg_prep_time`、`tickets_by_hour`），让 AI 跨 Analytics 和 KDS 数据问答（"7 点出餐慢，销售有没有受影响？"）

---

## 7. 设计系统：Backoffice 独立的"审美天花板"

**重要决定**：Backoffice 不沿用 KDS 视觉语言。两个产品定位不同：

- KDS 是 **Floor 工具**：暖色、亲和、容错性高、屏幕距离 1m 看
- Backoffice 是 **决策工具**：克制、高级、信息密度大、屏幕距离 0.5m 看 + 长时间凝视

KDS 的纸张暖色调对厨房设备是优秀选择，但放到分析仪表盘上会显得轻薄、不严肃。Backoffice 应有自己的审美语言。

### 7.1 设计哲学

我替你拍板（你说不懂审美），三大原则：

1. **克制（Restrained）**——不堆颜色不堆装饰，让数据本身成为视觉主角
2. **精确（Precise）**——所有数字 tabular-nums 对齐，所有间距按 4px 网格，所有色彩有目的
3. **从容（Calm）**——大量呼吸空间、不刺眼、长时间使用不疲劳

**同时**，我们会注入"餐饮"基因（不是字面 emoji，而是节奏感）——比如某个微妙的暖色 accent、衬线字体的标题、对食物级精致质感的追求。这是审美天花板与"通用 SaaS 模板"的区别。

### 7.2 选定方向：**C. Modern Fintech**

参照对象：Stripe Dashboard、Mercury、Ramp、Linear（部分）。气质：**polished, trustworthy, institutional**。

#### 设计 Token（写入 `apps/backoffice-web/app/globals.css`）

```css
:root {
  /* Color — Light mode */
  --background: 0 0% 100%;              /* #ffffff 净白 */
  --background-subtle: 240 5% 96%;      /* #f4f4f5 zinc-100 大区背景 */
  --card: 0 0% 100%;                    /* 卡片白底 */
  --card-border: 240 6% 90%;            /* #e4e4e7 zinc-200 微边框 */
  --card-shadow: 240 6% 10% / 0.04;     /* 极柔阴影 */
  
  --foreground: 240 6% 10%;             /* #18181b zinc-900 主文字 */
  --foreground-muted: 240 4% 46%;       /* #71717a zinc-500 次文字 */
  --foreground-faint: 240 5% 64%;       /* #a1a1aa zinc-400 极弱 */
  
  --accent: 158 64% 39%;                /* #059669 emerald-600 主 accent */
  --accent-soft: 152 76% 96%;           /* #ecfdf5 emerald-50 hover 背景 */
  --accent-foreground: 0 0% 100%;       /* 白色文字 on accent */
  
  --secondary-accent: 263 70% 50%;      /* #7c3aed violet-600 次 accent */
  --secondary-accent-soft: 270 100% 98%;
  
  /* Trend colors — 绿涨红跌（西方业界标准）*/
  --trend-up: 158 64% 39%;              /* emerald-600 */
  --trend-up-bg: 152 76% 96%;
  --trend-down: 0 72% 51%;              /* #dc2626 red-600 */
  --trend-down-bg: 0 86% 97%;           /* red-50 */
  --trend-neutral: 240 4% 46%;
  
  /* Chart palette — 6 色，深色调，互不"打架" */
  --chart-1: 158 64% 39%;               /* emerald-600 */
  --chart-2: 263 70% 50%;               /* violet-600 */
  --chart-3: 199 89% 48%;               /* sky-500 */
  --chart-4: 25 95% 53%;                /* orange-500 */
  --chart-5: 340 82% 52%;               /* rose-500 */
  --chart-6: 217 91% 60%;               /* blue-500 */
  
  /* Radius */
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 14px;
  --radius-card: 12px;
  --radius-button: 8px;
  --radius-input: 8px;
  --radius-pill: 999px;                 /* 仅用于 badge 和 status */
  
  /* Spacing — 4px grid */
  /* Use Tailwind defaults: space-1=4px, space-2=8px, space-4=16px, space-6=24px, space-8=32px */
  
  /* Font */
  --font-sans: "Inter", system-ui, sans-serif;
  --font-display: "Inter", system-ui, sans-serif;  /* 同 Inter，但 KPI 用 font-medium tracking-tight */
  --font-mono: "JetBrains Mono", "SF Mono", monospace;
  
  /* Animation */
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --duration-fast: 120ms;
  --duration-base: 200ms;
}

.dark {
  --background: 240 10% 4%;             /* #0a0a0b zinc-950 */
  --background-subtle: 240 6% 10%;      /* #18181b zinc-900 */
  --card: 240 6% 10%;
  --card-border: 240 4% 16%;            /* zinc-800 */
  --card-shadow: 0 0% 0% / 0.3;
  --foreground: 0 0% 98%;
  --foreground-muted: 240 5% 64%;       /* zinc-400 */
  --foreground-faint: 240 4% 46%;
  --accent: 158 64% 52%;                /* emerald 浅一档 for dark mode 对比度 */
  --trend-up: 158 64% 52%;
  --trend-down: 0 84% 60%;
}
```

#### Tailwind 配置要点（`tailwind.config.ts`）

```ts
import type { Config } from 'tailwindcss'
const config: Config = {
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-sans)'],
        display: ['var(--font-display)'],
        mono: ['var(--font-mono)']
      },
      colors: {
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        muted: 'hsl(var(--foreground-muted))',
        card: { DEFAULT: 'hsl(var(--card))', border: 'hsl(var(--card-border))' },
        accent: { DEFAULT: 'hsl(var(--accent))', soft: 'hsl(var(--accent-soft))' },
        trend: {
          up: 'hsl(var(--trend-up))',
          down: 'hsl(var(--trend-down))',
          neutral: 'hsl(var(--trend-neutral))'
        },
        chart: {
          1: 'hsl(var(--chart-1))',
          2: 'hsl(var(--chart-2))',
          3: 'hsl(var(--chart-3))',
          4: 'hsl(var(--chart-4))',
          5: 'hsl(var(--chart-5))',
          6: 'hsl(var(--chart-6))'
        }
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        card: 'var(--radius-card)',
        button: 'var(--radius-button)',
        input: 'var(--radius-input)',
        pill: 'var(--radius-pill)'
      }
    }
  }
}
export default config
```

#### 字体加载（`apps/backoffice-web/app/layout.tsx`）

```tsx
import { Inter, JetBrains_Mono } from 'next/font/google'
const inter = Inter({ subsets: ['latin'], variable: '--font-sans', display: 'swap' })
const jetMono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono', display: 'swap' })
// className={`${inter.variable} ${jetMono.variable}`}
```

#### shadcn/ui 主题 override

`components.json` 配置 baseColor: `zinc`，再覆盖 `globals.css` 中的 shadcn CSS 变量到我们的 token。具体覆盖项 Phase 0 落地。

#### 关键组件视觉规则

| 组件 | 规则 |
|---|---|
| `Button` (default) | `rounded-button bg-foreground text-background hover:opacity-90`，**不用** shadcn 默认蓝 |
| `Button` (secondary) | `rounded-button border border-card-border bg-transparent` |
| `Button` (accent) | `rounded-button bg-accent text-accent-foreground` |
| `Card` | `rounded-card bg-card border border-card-border shadow-[0_1px_2px_hsl(var(--card-shadow))]` |
| `Input` | `rounded-input border border-card-border bg-transparent focus:ring-2 focus:ring-accent/20` |
| `Badge` (status) | `rounded-pill text-xs px-2 py-0.5 font-medium` |
| `Sheet` / `Dialog` | `rounded-lg bg-card`，遮罩 `bg-foreground/40 backdrop-blur-sm` |
| `Sidebar` | 左固定 240px，`bg-background-subtle border-r border-card-border`，菜单项 `rounded-md` 高 36px |
| `Tooltip` | 深色反差（在浅色模式下 `bg-foreground text-background`），`rounded-md text-xs` |
| KPI 大数字 | `font-display text-3xl font-medium tracking-tight tabular-nums text-foreground` |
| Trend pill | `text-xs font-medium rounded-pill px-1.5 py-0.5`，根据涨跌切 `bg-trend-up/-down` |
| 图表轴 / 网格 | 浅 `stroke-card-border`，文字 `fill-foreground-muted text-xs` |
| 图表 tooltip | shadcn Card 风，包含数据点的格式化值 |

#### 装饰元素（不滥用）

- 登录页背景：极柔 emerald → violet 渐变（透明度 < 5%）
- 主页 Hero KPI 区底部：极淡渐变分隔线
- AI 浮窗按钮：圆形 + 内环 emerald 渐变 + 微弱 shadow
- 其他页面：保持净白 / 极简，让数据本身成为视觉主角

### 7.2.1 组件来源策略（重要）

**核心原则：最大化使用现成组件，AI 不允许从零写有 shadcn 替代品的组件**。

| 用途 | 必须用什么 | 安装命令 |
|---|---|---|
| **侧边栏** | shadcn `sidebar-07` block（含分组、折叠、移动端 sheet） | `pnpm dlx shadcn@latest add sidebar-07` |
| **Dashboard 整体布局** | shadcn `dashboard-01` 或 `dashboard-04` block | `pnpm dlx shadcn@latest add dashboard-01` |
| **登录页** | shadcn `login-03` block | `pnpm dlx shadcn@latest add login-03` |
| **图表（核心）** | **shadcn/ui Charts**（Recharts 的 shadcn 包装，自动套主题） | `pnpm dlx shadcn@latest add chart` |
| **数据表** | TanStack Table v8（逻辑）+ shadcn `Table` 组件（视觉） | `pnpm dlx shadcn@latest add table` |
| **日期范围选择** | shadcn `Calendar` + 自建 DateRangePicker（参照 shadcn 文档） | `pnpm dlx shadcn@latest add calendar` |
| **Cmd+K 搜索 / AI 浮窗输入** | shadcn `Command`（基于 cmdk） | `pnpm dlx shadcn@latest add command` |
| **下拉 / 抽屉 / 对话框 / Tabs / Toast** | shadcn primitives | `pnpm dlx shadcn@latest add dropdown-menu sheet dialog tabs sonner` |
| **复杂可视化**（Sankey、力导向图） | ECharts（v2 新增） | 仅 v2 起用 |
| **菜单工程 2×2 象限气泡图** | Recharts ScatterChart 自定义 | 唯一允许 AI 自定义实现的图表（无现成方案） |
| **GitHub-style 日历热力** | `react-calendar-heatmap` + 自定义主题 | 第三方库 |

#### 严格禁止

- ❌ 让 AI 从零写 SVG 图表
- ❌ 让 AI 从零写 sidebar / collapsible nav
- ❌ 引入 Tremor（视觉跟 Modern Fintech 打架）
- ❌ 引入 MUI / Ant Design / Chakra（审美方向冲突）
- ❌ 引入第二个图表库（Recharts 之外，除非 v2 加 ECharts）

#### shadcn Charts 用法约束

所有图表必须包在 `<ChartContainer>` 中（shadcn 提供）：

```tsx
import { ChartContainer, ChartTooltip, ChartTooltipContent, ChartLegend } from "@/components/ui/chart"
import { Line, LineChart, XAxis, YAxis, CartesianGrid } from "recharts"

const chartConfig = {
  netSales: { label: "Net Sales", color: "hsl(var(--chart-1))" },
  prior: { label: "Prior Period", color: "hsl(var(--chart-3))" }
} satisfies ChartConfig

<ChartContainer config={chartConfig} className="h-72">
  <LineChart data={data}>
    <CartesianGrid strokeDasharray="3 3" />
    <XAxis dataKey="hour" />
    <YAxis />
    <ChartTooltip content={<ChartTooltipContent />} />
    <Line dataKey="netSales" stroke="var(--color-netSales)" strokeWidth={2} />
  </LineChart>
</ChartContainer>
```

这种写法的好处：
- 配色全自动跟 `chart-1..6` token 走
- Tooltip 已经是 shadcn Card 样式
- 图例、网格、轴文字全部已主题化
- 暗色模式自动适配

**写在 `apps/backoffice-web/CLAUDE.md`**：

> ⚠️ NEVER hand-write a chart. Always use `<ChartContainer>` from `@/components/ui/chart`. If you need a chart variant that doesn't exist, ADD a shadcn chart block first via `pnpm dlx shadcn add chart-xxx`, then customize.

> ⚠️ NEVER hand-write a sidebar, sheet, dialog, dropdown, or table component. Always use the shadcn equivalent. If shadcn lacks a primitive you need, ASK before writing from scratch.

### 7.3 不变的"硬骨头"

| 项 | 标准 |
|---|---|
| 数字字符 | `tabular-nums` 全局 |
| 货币 | `$1,234.56` 2 位小数固定 |
| 百分比 | `+12.3%` 1 位小数 + 上/下箭头（**不只是颜色**——色盲友好） |
| **趋势色** | **绿涨红跌**（西方业界标准 / 金融类产品默认） |
| 间距网格 | 4px 基础（Tailwind 默认） |
| 字体加载 | `next/font` 自托管，避免 FOIT/FOUT |
| 微交互 | `framer-motion` 节制：仅页面切换淡入 + 关键反馈 |
| 加载态 | Skeleton（不用 spinner，除非超过 3s） |
| 空状态 | 简洁文字 + CTA，不用插画 |
| 错误态 | 友好语气，不暴露 stack trace |
| 图表配色 | 6 色循环，已通过 WCAG AA 对比测试 |
| 暗色模式 | **支持但默认浅色**（fintech 默认浅色） |
| 字数密度 | 段落 ≤ 60 字符宽（readability 标准） |
| Focus 状态 | 全部组件可 keyboard navigate，焦点环 `ring-2 ring-accent/40` |
| 响应式断点 | mobile <768 / tablet 768-1024 / desktop 1024+；Today 移动端首要公民 |

### 7.4 跟 KDS 的关系

- KDS 设计 tokens **不动**（保留 KDS web 现有 globals.css）
- Backoffice 有自己的 `apps/backoffice-web/app/globals.css`
- 仅共享：品牌名 "Example Kitchen" + Logo（待你确认是否有 logo）
- `packages/ui-tokens` 这个 package **取消**——没必要为两个不共享视觉的产品强抽
- 未来 Inventory 跟 Backoffice 共享设计语言（同属 Backoffice 套壳），不跟 KDS 共享

---

## 8. 技术栈最终确认

| 层 | 选择 | 备注 |
|---|---|---|
| **Monorepo** | pnpm 10 workspace | 已经是 KDS 现状 |
| **Backoffice 框架** | Next.js 15 App Router + React 19 | TS strict |
| **Backoffice 样式** | Tailwind CSS v4 + shadcn/ui（Modern Fintech 主题） | |
| **Backoffice 图标** | Lucide React | |
| **Backoffice 图表 v1** | **shadcn/ui Charts**（Recharts 包装） | 强制：禁止 AI 写裸 Recharts |
| **Backoffice 图表 v2** | ECharts + echarts-for-react | 复杂热力 / sankey 才加 |
| **Backoffice Sidebar / 布局** | **shadcn blocks**（sidebar-07, dashboard-01） | 不允许手撸 |
| **Backoffice 服务端状态** | TanStack Query v5 (`staleTime: 60_000`) | |
| **Backoffice 表格** | TanStack Table v8（逻辑）+ shadcn `Table`（视觉） | |
| **Backoffice 表单** | react-hook-form + zod | 共享 zod schemas via `packages/contracts` |
| **Backoffice 客户端状态** | Zustand（必要时） | |
| **Backoffice 日期** | Luxon | 跟 Analytics-API / KDS-API 对齐 |
| **Backoffice AI SDK** | Vercel AI SDK + `@ai-sdk/anthropic` | |
| **AI 模型** | `claude-sonnet-4-6` 主聊天 / `claude-haiku-4-5` 路由 | |
| **Analytics-API** | 保持现有 Node http + raw SQL + zod + Luxon | 不改造为 Fastify+Prisma |
| **KDS-API** | 保持现有 Fastify + Prisma + Redis + BullMQ | 不动 |
| **Auth (统一)** | Passkey + WebAuthn + Argon2id + cookie session | **抽自 KDS** → `packages/auth` |
| **测试** | Vitest + RTL + Playwright | 跟 KDS 对齐 |
| **格式化** | Prettier + ESLint flat config | KDS 当前没 Prettier，**新增** |
| **部署** | Docker + Traefik (`traefik-servicenet`) | 跟 KDS 对齐 |

---

## 9. API 契约

`apps/backoffice-web` 是 Next.js 应用，通过两类方式访问数据：

1. **BFF 层（Next.js Route Handler `/api/*`）**——浏览器直接调用，服务端注入 session cookie
2. **后端 typed endpoints**——BFF 转发到 `analytics-api` 或 `kds-api`

```
# Auth (BFF → packages/auth)
POST /api/auth/login              { credential | password } → cookie
POST /api/auth/logout
GET  /api/auth/me                 → { user, expires_at }
POST /api/auth/passkeys/register
DELETE /api/auth/passkeys/:id

# Analytics
GET  /api/today                   ?date=
GET  /api/trends/timeseries       ?metric=&grain=&from=&to=
GET  /api/trends/calendar         ?from=&to=
GET  /api/trends/breakdown        ?dim=&from=&to=
GET  /api/compare                 ?primary_from=&primary_to=&compare_from=&compare_to=&grain=&breakdown=&metric=
GET  /api/menu/items              ?from=&to=&sort=&search=
GET  /api/menu/items/:id          ?from=&to=
GET  /api/menu/quadrant           ?from=&to=
GET  /api/dayparts/heatmap        ?from=&to=
GET  /api/dayparts/breakdown      ?from=&to=&granularity=

# KDS Admin (BFF → kds-api)
GET  /api/kds/board-settings
PUT  /api/kds/board-settings
GET  /api/kds/devices
GET  /api/kds/integrations
PUT  /api/kds/integrations/clover
GET  /api/kds/users
POST /api/kds/users/passkeys

# Operations (BFF → analytics-api)
GET  /api/ops/overview
GET  /api/ops/jobs
GET  /api/ops/quality
GET  /api/ops/backfill
GET  /api/ops/webhooks
GET  /api/ops/database

# AI
POST /api/ai/chat                 SSE 流式
```

后端配套新增（在 `analytics-api`）：
- `apps/analytics-api/src/http/api-v1.ts` — 暴露 typed analytics endpoints（给 BFF 和未来 MCP 用）
- `apps/analytics-api/src/analytics/typed-queries.ts` — 强类型查询函数库
- `apps/analytics-api/sql/migrations/008_ai_session_log.sql` — 给 audit.ai_query_log 加 session_id / message_id / tool_name
- `apps/analytics-api/sql/migrations/009_auth_sessions.sql` — sessions 表（如果 packages/auth 决定持久化到 analytics 库；或落到 kds 库共用）

---

## 10. 部署：Docker + Traefik 多 App

KDS 现有 docker-compose.yml 已经在 traefik-servicenet 网络，扩展加 backoffice-web 和 analytics-api：

```yaml
services:
  # === 现有 KDS（不动）===
  migrate, api (kds-api), worker, web (kds-web), postgres (kds-db), redis
  
  # === 新增 Analytics ===
  analytics-postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: rop_analytics
      POSTGRES_PASSWORD: ${ANALYTICS_POSTGRES_PASSWORD}
    volumes:
      - analytics-postgres-data:/var/lib/postgresql/data

  analytics-api:
    build: { context: ., dockerfile: apps/analytics-api/Dockerfile }
    environment:
      <<: *app-env
      DATABASE_URL: postgresql://postgres:...@analytics-postgres:5432/rop_analytics
      ADMIN_TOKEN: ${ADMIN_TOKEN}  # 给老 dashboard 兼容期保留
    networks: [internal, traefik]
    labels:
      - traefik.enable=true
      - traefik.http.routers.analytics-api.rule=Host(`api.intelligence.example.com`)
      - traefik.http.routers.analytics-api.entrypoints=websecure
      - traefik.http.routers.analytics-api.tls=true

  backoffice-web:
    build: { context: ., dockerfile: apps/backoffice-web/Dockerfile }
    environment:
      NODE_ENV: production
      INTERNAL_ANALYTICS_API_URL: http://analytics-api:8080
      INTERNAL_KDS_API_URL: http://api:4000
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
      SESSION_SECRET: ${SESSION_SECRET}
    networks: [internal, traefik]
    labels:
      - traefik.enable=true
      - traefik.http.routers.backoffice.rule=Host(`app.example.com`)
      - traefik.http.routers.backoffice.entrypoints=websecure
      - traefik.http.routers.backoffice.tls=true
      - traefik.http.services.backoffice.loadbalancer.server.port=3000
```

**域名规划**：
- `kds.example.com` → KDS web (Floor 不动)
- `api.kds.example.com` → KDS api (现有 path-based 路由可改成 subdomain，可选)
- `app.example.com` → Backoffice web（**老板登录这里**）
- `api.intelligence.example.com` → Analytics API
- 已有的 `intelligence.example.com`：v1 期间保留为 admin dashboard（兼容期），Phase 7 删除入口

---

## 11. 认证（统一 Passkey + cookie session）

**抽出到 `packages/auth`**，KDS 和 Backoffice 共享：

```
packages/auth/
├── src/
│   ├── server/
│   │   ├── session.ts          # 创建 / 验证 / 销毁 session（Postgres backed）
│   │   ├── passkey.ts          # WebAuthn challenge / verify
│   │   ├── password.ts         # Argon2id hash / verify
│   │   ├── rate-limit.ts
│   │   └── middleware.ts       # Fastify 和 Next.js 适配器
│   ├── client/
│   │   ├── login.ts            # 浏览器端 passkey API 包装
│   │   └── api-client.ts       # 带 cookie 的 fetch
│   └── schema.sql              # auth 相关表（users, passkeys, sessions, audit_log）
└── package.json
```

**Sessions 表所在数据库**：放在 `kds-db` 还是新建独立 auth db？

- **强意见**：放在 KDS 数据库（已有 WebAdminAccount 模型），Analytics-API 读取 session 时跨库查询不可行，所以由 Backoffice-web 的 BFF 验证 session，向 analytics-api 转发时附带"经过认证"的内部 header。
- 这避免了 analytics-api 跟 auth 强耦合，保持 OLAP 后端的简洁。

**ADMIN_TOKEN 保留**：v1 期间 analytics-api 的 `/admin/api/*` 仍接受 ADMIN_TOKEN，作为 Backoffice 故障时的紧急后门。Phase 7 评估是否拆除。

---

## 12. AI 协作规则文件体系（`AGENTS.md` + `CLAUDE.md` 双标准）

你同时用 Claude Code 和 Codex。**两边读不同文件名**：
- Claude Code 读 `CLAUDE.md`（支持 `@<path>` 导入）
- Codex / Cursor / 其他通用 AI 工具读 `AGENTS.md`

**统一策略：`AGENTS.md` 是事实源；`CLAUDE.md` 是单行的 `@AGENTS.md` 导入**。

每个目录里这样设置：

```
# AGENTS.md   ← 真正的内容（适用于 Codex 和任何通用 AI 工具）
（详细规则、文件清单、命令、禁止项……）
```

```
# CLAUDE.md
@AGENTS.md
```

这样两个 AI 工具读同一份内容，单一维护点，规则永不漂移。

**6 个目录需要 `AGENTS.md` + `CLAUDE.md`**（Phase 0 第一件事）：

| 目录 | 角色 | 重点内容 |
|---|---|---|
| `restaurant-ops-platform/`（根） | 套件导航 | 三 apps 关系、何时去哪个子目录、`pnpm dev/test/lint/build` 全局命令 |
| `apps/kds-web/` | KDS 前端约束 | ⚠️ **禁止修改 board / display 页面**；只可改 admin（迁移期） |
| `apps/kds-api/` | KDS 后端约束 | Fastify + Prisma 风格，Clover 集成约定 |
| `apps/backoffice-web/` | Backoffice 前端规范 | Modern Fintech 设计 token 规则、shadcn 组件强制使用、图表禁止手撸、AI 工具调用约定 |
| `apps/analytics-api/` | Analytics 后端 | raw SQL + safe-query + 优先 mart MV、不要改造为 Prisma |
| `packages/auth/` | Auth 库 | 不要在 app 里写 auth 逻辑、所有 session 操作走此 package |
| `packages/contracts/` | 共享 zod | 跨 apps 改 schema 必须同步检查 KDS / Backoffice 双方 |

**KDS 已有的 `AGENTS.md`**（仓库根级）保留并扩展为整个 monorepo 的根级文档，不另起新的。

### 12.1 `apps/backoffice-web/AGENTS.md` 关键约束清单（写死，不可破）

```
# Backoffice Web — Agent rules

## Stack
Next.js 15 App Router · React 19 · TS strict · Tailwind v4 · shadcn/ui · TanStack Query/Table · Recharts (via shadcn charts) · Vercel AI SDK · Luxon

## Path aliases
@/* → apps/backoffice-web/*

## Hard rules — DO NOT VIOLATE

### Components
1. Never hand-write a component if shadcn/ui has it. Run `pnpm dlx shadcn@latest add <name>` first, then customize.
2. Never hand-write SVG charts. Always use `<ChartContainer>` from `@/components/ui/chart`.
3. Never hand-write a sidebar, dialog, sheet, dropdown, command palette, or table.
4. Never introduce a second component library (Tremor, MUI, Ant, Chakra). shadcn only.
5. Never edit shadcn primitives' core API; only customize visuals via Tailwind classes.

### Design tokens
6. All colors via CSS variables (`hsl(var(--*))`). Never hardcode hex except in `globals.css`.
7. All spacing via Tailwind `space-N` (4px grid). Never use arbitrary values like `p-[13px]`.
8. All numbers `tabular-nums`. All money via `lib/format.ts#formatUSD`. All percentages via `formatPercent`.
9. All chart colors via `chart-1..6` tokens. Never hardcode chart colors.
10. Trend up = green (`trend-up`), trend down = red (`trend-down`). Never reverse.

### Data
11. All data fetching via TanStack Query hooks in `hooks/use-*.ts`. Never call `fetch` directly in components.
12. All API calls go through `lib/api.ts` (BFF client). Browser never talks to analytics-api or kds-api directly.
13. All zod schemas live in `packages/contracts` if shared, else in `apps/backoffice-web/types/`.

### AI
14. AI tool definitions ONLY in `lib/ai/tools.ts`. New tools require both a backend typed endpoint AND a tool definition.
15. Never call AI provider SDK from browser. All AI calls go through `/api/ai/chat` Route Handler.

### Code style
16. No inline comments unless WHY is non-obvious. No "// fixed bug" or "// added for issue #123" comments.
17. No `console.log` in committed code. Use `console.debug` guarded by env flag if absolutely needed.
18. No emojis in UI text. No emojis in code or comments.
19. No TypeScript `any`. Use `unknown` + narrow.

### Performance
20. Default `staleTime: 60_000` for queries (mart MVs refresh every 5min, no point hammering).

## Verification before "done"
- pnpm typecheck
- pnpm lint
- pnpm test
- pnpm dev → open localhost via mcp__Claude_in_Chrome → screenshot the affected page
```

### 12.2 `apps/kds-web/AGENTS.md` 关键约束（保护性）

```
# KDS Web — Agent rules

## Hard boundary
⚠️ DO NOT touch board page (`src/app/board/*`) or customer-display page.
⚠️ DO NOT touch the existing globals.css design tokens — KDS visual language is locked.

The only edits expected here during the Backoffice migration phase are:
- Removing the entrypoint to /admin pages once they migrate to backoffice-web.
- Refactoring auth code to consume `packages/auth` (no behavior change).

If you need to add a new feature here, STOP and ask the human.
```

### 12.3 KDS 现有 `AGENTS.md` 处理

KDS 已经在仓库根级有 `AGENTS.md`。Phase 0 迁移时：
- 把它的内容**合并进新根级 `AGENTS.md`**（描述整个 monorepo 三 apps）
- 旧 KDS 特有的内容拆到 `apps/kds-web/AGENTS.md` 和 `apps/kds-api/AGENTS.md`
- 在新根 `CLAUDE.md` 写 `@AGENTS.md`

---

## 13. AI 协作工作流（针对此项目）

### 13.1 单 Agent vs 多 Agent 并行

**单 Agent**（必须）：
- Phase 0（仓库迁移）
- Phase 1（auth + shell + tokens）
- Phase 6（AI 浮窗集成）

**可多 Agent 并行**（git worktree）：
- Phase 2（Today + Trends）
- Phase 3（Compare）
- Phase 4（Menu）
- Phase 5（Dayparts + KDS Admin 迁移 + Operations）

**最佳实践**：3–5 个 worktree 上限，每个 worktree 独立分支。共享改动（tokens / auth）必须在所有 worktree merge 前完成。

### 13.2 Phase 切分原则

每个 phase 必须是**垂直切片**：
- 一个或几个完整页面
- 配套的 BFF 路由
- 配套的后端 typed endpoint
- 配套的测试
- 一张演示截图

### 13.3 反馈环

每 phase 结束前必须全绿：
- `pnpm typecheck` ✅
- `pnpm lint` ✅
- `pnpm test` ✅
- `pnpm e2e`（关键流） ✅
- 主页面 1 张截图（Claude 用 `mcp__Claude_in_Chrome` 自己截）

### 13.4 issue 文件模板

我会替你建 `.claude/issues/phase-N-XX.md`，每个 issue 含：
- 目标
- 文件清单
- API 契约
- 验收脚本

---

## 14. 分阶段实施计划

### Phase 0 — 套件 Monorepo 基础（约 2 sessions）

**这是最关键也最敏感的 phase。所有后续 phase 依赖此。**

- [ ] 决定迁移策略：是 (a) 重命名 `restaurant-ops-platform-KDS` 为 `restaurant-ops-platform` + git filter-repo 把 Intelligence 历史并入，还是 (b) 新建 `restaurant-ops-platform` 仓库 + 两个 subtree。**推荐 (a)**——KDS git 历史更长更重要，把 Intelligence 作为新加目录引入。
- [ ] 在 KDS 仓库里：
  - [ ] 移 `apps/api` → `apps/kds-api`，`apps/web` → `apps/kds-web`
  - [ ] 移 `packages/db` → `packages/db-kds`，`packages/contracts` 保留（扩展）
  - [ ] 重命名 git remote 和仓库名
- [ ] 新建 `apps/analytics-api/`，把 `restaurant-ops-platform-Intelligence/{src,sql,tests,docs}` 整体迁入
- [ ] 新建 `apps/backoffice-web/`，`pnpm create next-app` 初始化（TS strict, App Router, Tailwind, ESLint）
- [ ] Backoffice 设计语言落地：根据所选审美方向写 `app/globals.css`、`tailwind.config.ts`、`next/font` 字体配置、shadcn `components.json` theme
- [ ] 新建 `packages/auth/` 占位（接口定义；具体实现 Phase 1）
- [ ] 升级 root `package.json` workspace scripts（涵盖 4 个 apps）
- [ ] 写 6 份 `AGENTS.md`（事实源）+ 6 份 `CLAUDE.md`（每份单行 `@AGENTS.md` 导入）—— 详见 §12
- [ ] 合并现有 KDS 的 `AGENTS.md` 内容到新根级 `AGENTS.md`
- [ ] 装 backoffice-web 依赖：shadcn/ui、TanStack Query/Table、Recharts、Lucide、Luxon、Vercel AI SDK
- [ ] 配 Prettier 根级
- [ ] 配 Vitest + RTL + Playwright 骨架
- [ ] 写 `Dockerfile.backoffice-web` 和 `Dockerfile.analytics-api`
- [ ] 改 `docker-compose.yml`：增加 analytics-postgres、analytics-api、backoffice-web 服务

**验收**：
- `pnpm dev` 起 4 个进程：kds-api / kds-web / analytics-api / backoffice-web
- KDS 现有功能完全无变化（`pnpm test` 全绿，board 页面打开正常）
- Backoffice 显示 placeholder 页
- `pnpm typecheck && pnpm lint && pnpm test` 全绿

### Phase 1 — Auth + Shell（约 1.5 sessions）

- [ ] 实现 `packages/auth`：从 KDS 现有 `apps/web/src/lib/auth*.ts`（旧 restaurant-ops-platform-KDS 仓库） 抽出共享逻辑
- [ ] KDS 重构成消费 `packages/auth`（保持行为完全不变，只是不再 inline 写 auth）
- [ ] Backoffice 实现 `/login` + middleware
- [ ] Backoffice 通过 Internal API 验证 session 后，向 analytics-api 转发请求时附 `X-Rop-Internal: <signed-jwt>` header（避免 analytics-api 跟 auth 强耦合）
- [ ] Backoffice 应用 shell：左侧 Sidebar（4 个分组的菜单 + Lucide 图标）+ TopBar（用户菜单 + AI 浮球占位）
- [ ] 全部页面 placeholder
- [ ] AI 浮球（点开空 Sheet，先不接 API）

**验收**：用 KDS 登录的 passkey 同样能登录 Backoffice；KDS 自己的登录依然工作；菜单切换正常。

### Phase 2 — Analytics Today + Trends（约 2 sessions，可并行 Track A）

- [ ] analytics-api 新增 `/api/v1/today`、`/api/v1/trends/*` typed endpoints
- [ ] backoffice-web BFF：`/api/today`、`/api/trends/*`
- [ ] Today 页：4 KPI 卡 + Hourly Pulse + Auto-Insights（规则版） + Top 5 Items + WoW mini-bar
- [ ] Trends 页：时序图 + 日历热力 + 3 tab 分段细分 + 数据表

**验收**：与现有 `/admin/api/sales` 数据一致；自动 60s 刷新；截图。

### Phase 3 — Compare 页（约 2 sessions，可并行 Track B）

- [ ] analytics-api 新增 `/api/v1/compare`（含 breakdown）
- [ ] backoffice-web BFF：`/api/compare`
- [ ] 控制条 6 个筛选器，URL state
- [ ] 主对比图（柱/折线自适应）
- [ ] Diff 数据表（条件格式）
- [ ] Day-of-Week 模式

**验收**：4 典型场景能复现。

### Phase 4 — Menu 页（约 2 sessions，可并行 Track C）

- [ ] analytics-api 新增 `/api/v1/menu/*`
- [ ] backoffice-web BFF：`/api/menu/*`
- [ ] 菜单工程象限气泡图
- [ ] TanStack Table（排序/搜索/多选/虚拟化）
- [ ] 单品下钻 sheet（时序 + hour×weekday heatmap + modifier 排行）

**验收**：top items 数据匹配。

### Phase 5 — Dayparts + KDS Admin 迁移 + Operations（约 2 sessions）

- [ ] analytics-api 新增 `/api/v1/dayparts/*`、`/api/v1/ops/*`（多数代理 `/admin/api/*`）
- [ ] kds-api 暴露 `/api/v1/admin/*` typed endpoints（如不存在，从现有 KDS `/admin/*` route 抽 BFF 风格）
- [ ] Dayparts 页：核心热力图 + daypart 占比 + hour curve
- [ ] **KDS Admin 子页面迁移**：Board Settings / Devices / Integrations / Daily Reset / Users & Passkeys（5 个子页面）
- [ ] Operations 页 6 tab
- [ ] 删除 KDS web 老 admin 入口
- [ ] 删除 Intelligence 老 admin dashboard 渲染（保留 JSON API）

**验收**：KDS admin 在 Backoffice 完全可用，KDS web 不再显示 admin 入口；Operations 数据正常。

### Phase 6 — AI 助手（约 2–3 sessions）

- [ ] analytics-api：每个 typed tool 对应一个 `/api/v1/ai/tools/*` endpoint
- [ ] migration 010：扩展 audit.ai_query_log（session_id / message_id / tool_name）
- [ ] backoffice-web `/api/ai/chat` Route Handler，Vercel AI SDK streamText
- [ ] 8 tools 定义在 `apps/backoffice-web/lib/ai/tools.ts`
- [ ] 系统提示在 `lib/ai/prompts.ts`，含页面上下文注入
- [ ] 浮窗 UI：Sheet + 流式 + Markdown + tool call 卡片 + 建议气泡
- [ ] 图表 / 卡片旁的"Ask AI"按钮
- [ ] 限速（token bucket）
- [ ] Audit log 写入

**验收**：5 个标准问题作答正确：
1. "Why was lunch slow today?"
2. "Top items today"
3. "Compare this week to last week"
4. "Best hours on Tuesdays"
5. "Show me items that dropped most this week"

### Phase 7 — 收尾 + 部署（约 1 session）

- [ ] 全局 loading skeleton、empty state、error boundary
- [ ] Playwright E2E 覆盖关键流
- [ ] 部署到 Oracle：docker-compose up，Traefik 自动签证书
- [ ] 烟测：访问 `https://app.example.com`
- [ ] 删除 KDS 老 admin 入口（如未在 Phase 5 删）
- [ ] 评估：保留 / 删除 ADMIN_TOKEN 兼容路径

**验收**：生产环境能用，HTTPS 正常，AI 助手能答问题。

---

## 15. 风险 & 待你确认的开放问题

| 风险 | 应对 |
|---|---|
| Phase 0 monorepo 迁移可能动到 KDS 现有功能 | 每步都跑 KDS 的 `pnpm test` 和 `pnpm test:e2e`，发现回归立即 git revert |
| Postgres 物化视图对任意 breakdown 可能慢 | Phase 3 早期 profile，必要时加 index 或新 MV |
| AI 调用成本失控 | prompt cache + 限速 + audit log + 月预算 alert |
| `claude-sonnet-4-6` 模型 ID 可能变 | 写到 prompts.ts 顶部常量 |
| analytics-api 跟 packages/auth 弱耦合的内部 JWT 方案需要自建 | Phase 1 设计 token 签名，避免重新发明 SSO |
| 单 ADMIN_TOKEN 兼容期重叠 passkey 系统 | Phase 7 评估清理 |

**Phase 0 之前需要你拍板**：

1. **仓库命名**：是把 `restaurant-ops-platform-KDS` 直接改名 `restaurant-ops-platform`，还是新建 `restaurant-ops-platform`？我推荐改名（保留 git 历史完整）。
2. **Intelligence 历史合并**：用 `git filter-repo` 把 Intelligence 历史完整保留地嵌入，还是只 copy 文件（丢历史）？我推荐前者。
3. **Backoffice 域名**：`app.example.com` OK 吗？
4. **Analytics-API 域名**：`api.intelligence.example.com` 还是 `api.analytics.example.com`？
5. **ANTHROPIC_API_KEY 准备好了吗**？月预算？
6. **Daypart 时间切分**（默认 6/11/14/17/21/24）符合你这家店吗？
7. **Default landing page**：登录后默认 Today，OK 吗？

---

## 16. v1 完成定义（DoD）

只有以下全部为真，v1 才算完成：

1. KDS 现有功能（board / display / login）**零回归**，跑得跟改造前一模一样
2. `https://app.example.com` 显示登录页，可用 KDS passkey 登录
3. Backoffice 7 个分析页面（Today / Trends / Compare / Menu / Dayparts + KDS Admin 5 子页 + Operations）渲染真实生产数据
4. AI 浮窗 5 个标准问题作答正确，每答都有 tool call 引用
5. KDS web 老 admin 入口被删，重定向到 Backoffice
6. Intelligence 老 dashboard 渲染被删，保留 JSON API
7. `pnpm test` + `pnpm e2e` 全绿
8. `audit.ai_query_log` 中所有 AI 工具调用可查
9. 在手机（iOS Safari）打开 Today 页面正常

---

## 17. 我会主动替你做的事

按你"我对设计/产品/开发都不懂"的需求，我会主动：

- 每个 Phase 开始前替你写 phase spec 文件 `.claude/issues/phase-N-XX.md`
- 每个 Phase 中给截图 + 中文进展解释
- 每次产品决策给 2–3 选项 + 推荐方案，不无脑反问
- 主动用业界惯例支撑设计选择
- 每个 PR 给中文 changelog
- Phase 0 迁移每步小心 KDS 不回归
- Phase 6 前帮你检查 ANTHROPIC_API_KEY 配置和限速
- 部署前 dry-run 检查 docker-compose

---

## 18. 调研来源

- [Toast Reporting & Analytics](https://pos.toasttab.com/products/reporting)
- [Toast Reporting Dashboard](https://support.toasttab.com/en/article/How-to-Use-the-Toast-Reporting-Dashboard)
- [Square 餐厅菜单工程分析](https://squareup.com/us/en/the-bottom-line/series/running-a-restaurant-is-no-joke/making-good-decisions)
- [Lightspeed: 22 Restaurant KPIs](https://www.lightspeedhq.com/blog/restaurant-kpis/)
- [Oracle 餐厅分析](https://www.oracle.com/food-beverage/restaurant-pos-systems/restaurant-analytics/)
- [Crunchtime 数据驱动 dashboard](https://www.crunchtime.com/blog/empowering-restaurants-with-a-data-centric-dashboard)
- [Quantic: 13 个必备 POS 报表](https://getquantic.com/restaurant-pos-reports/)
- [DataGPT 对话式数据分析师](https://datagpt.com/)
- [Tinybird: 构建对话式分析 AI](https://www.tinybird.co/blog/building-explorations-a-conversational-analytics-ai)
- [Smashing Magazine: 实时仪表盘 UX 策略](https://www.smashingmagazine.com/2025/09/ux-strategies-real-time-dashboards/)
- [Claude Code 文档：通用工作流](https://code.claude.com/docs/en/common-workflows)
- [Claude Code Worktrees 并行开发指南](https://claudefa.st/blog/guide/development/worktree-guide)
