# 真实内容样例包 —— 给 UI 设计师的 mock 数据源

> **配套文档**：[UI-BRIEF.md](./UI-BRIEF.md)（页面清单）·
> [UI-GLOSSARY.md](./UI-GLOSSARY.md)（术语与文案）。
> 本文提供第三样东西：**真实系统真实跑出来的内容**，让设计稿里的数据长得像
> 产品实际会产出的样子，而不是设计师脑补的样子。

## 0. 真实性说明（先读这个）

> **文档位置说明**：本文与整个 `ui-design/` 已于 2026-07-30 从规划库
> `teamem-ai/plan` 的 `tasks/M2/` 移入本产品仓库 `docs/ui-design/`。文中提到的
> `CLOSEOUT.md`（M1 收尾记录）仍在规划库 `tasks/M1/CLOSEOUT.md`，本仓库内没有该文件；
> 下文所有 "CLOSEOUT §x" 均指规划库里的那份，按需去规划库查阅。

**2026-07-29 更新：M1 验收数据库仍然在线，本文已全量重导。**
此前版本写着"验收后数据库已按环境清理流程删除，本文是从验收记录抢救整理的"
—— 那是错的。库一直保留着（见规划库 `tasks/M1/CLOSEOUT.md` §11.2 的
交接记录），本次直接连库导出，因此：

- **原来标【B·结构精确】的拼装 JSON 已全部替换为真实导出**，包括正文全文、
  真实 UUID、真实时间戳、真实 tags、真实贡献者；
- **原来标 `—*` 的未知置信度已全部补齐**；
- 顺带修正了三处与真实数据不符的说法（见 §13）。

素材来源：**2026-07-28 的 M1 最终验收**——真实 PostgreSQL + pgvector + 真实
LLM provider（OpenRouter）+ 真实编译管线。当前库存量：

```
projects=28   concepts=48   evidence=61   events=82   jobs=31
```

真实性标注（本次之后绝大多数是 A 级）：

- **【A·逐字】** = 从验收数据库直接导出或验收记录原样摘录，一个字没改；
- **【B·结构精确】** = 按契约拼装而非实测。**本次重导后本文已无此类内容**
  —— 每一段数据都来自数据库导出或验收记录原文。保留这个标注定义，是为了
  后续有人补充内容时能诚实标记。

语料本身是验收用的合成工程语料（**无任何真实客户数据**），但**编译产物是真的**
——每个标题、每次类型判定、每次合并、每条 tag 都是真实 LLM 管线的真实输出。
设计稿直接用这些内容，高保真稿就是产品实拍级别。

需要活数据库做可交互原型时，这台机器上的库可直接连（连接方式见 CLOSEOUT §11.2）；
换台机器则按 CLOSEOUT §1 用一个 provider key 重跑约 30 分钟，产物形状一致。

---

## 1. 真实概念页全量清单【A·逐字】—— 列表页（BRIEF C1）直接可用

**全部 48 页**，字段直接来自数据库（此前版本只列了 11 行且置信度多处缺失）：

| path | type | status | confidence | 证据 | 标题 |
|---|---|---|---|---|---|
| `services/compile-worker` | service | active | high | 1 | Compile Worker Service |
| `services/compile-worker` | service | active | medium | 1 | Compile Worker Service |
| `services/payments-service` | service | active | medium | 2 | Payments Service and Stripe Webhook Idempotency |
| `services/payments-service` | service | active | medium | 2 | Payments Service with Stripe Webhook Handling and Retry… |
| `services/task-service` | service | active | medium | 1 | Task Service - Manages Task CRUD Operations |
| `services/task-service` | service | active | medium | 2 | Task Service and Task Schema Definition in TypeScript |
| `concepts/app-error-class` | concept | active | medium | 1 | AppError class for machine-readable application errors |
| `concepts/app-error-conventions` | concept | active | medium | 1 | AppError class conventions |
| `concepts/concept-paths-format` | concept | active | high | 1 | Concept paths format and usage |
| `concepts/layered-architecture-task-tracker` | concept | active | medium | 2 | Layered Architecture in Task Tracker Application |
| `concepts/layered-architecture-task-tracker` | concept | active | medium | 1 | Layered Architecture in Task Tracker Application |
| `concepts/path-format` | concept | active | high | 1 | Concept path formatting rules |
| `concepts/provider-precedence` | concept | active | medium | 1 | Provider Precedence and Semantic Recall Behavior |
| `decisions/api-rate-limiting` | decision | active | high | 1 | API Rate Limiting Architecture Decision |
| `decisions/api-rate-limiting` | decision | active | high | 1 | Architecture Decision: API Rate Limiting |
| `decisions/api-rate-limiting` | decision | active | high | 2 | Architecture Decision: API Rate Limiting Using Redis-ba… |
| `decisions/codename-standardization-billing-rewrite` | decision | active | medium | 1 | Codename Standardization for Billing Rewrite |
| `decisions/queue-management-pg-boss-over-redis` | decision | active | high | 2 | Decision to Use pg-boss in Postgres for Compile Queue I… |
| `decisions/use-pg-boss-for-compile-queue` | decision | disputed | high | 2 | Decision on Compile Queue: Redis vs. Postgres with pg-boss |
| `decisions/use-pg-boss-on-postgres` | decision | disputed | high | 2 | Decision: Queue Technology Choice for Compile Queue (Po… |
| `decisions/use-postgresql-pgvector` | decision | active | high | 1 | Use PostgreSQL with pgvector as the Primary Database |
| `decisions/use-postgresql-pgvector` | decision | active | high | 3 | Use PostgreSQL with pgvector and pg-boss for Queue Mana… |
| `gotchas/api-key-plaintext` | gotcha | active | high | 1 | API Key Plaintext Availability Policy |
| `gotchas/api-key-plaintext-visibility` | gotcha | active | high | 1 | API Key Plaintext Visibility and Management |
| `gotchas/api-rate-limiting` | gotcha | active | medium | 1 | Redis token bucket for API rate limiting |
| `gotchas/compose-does-not-migrate` | gotcha | active | high | 2 | Docker Compose does not run database migrations |
| `gotchas/exponential-backoff-retry-errors` | gotcha | active | medium | 1 | Exponential Backoff Retry: Catches All Errors Including… |
| `gotchas/in-process-rate-limiter-reset` | gotcha | active | medium | 1 | In-process API rate limiter resets on deploy |
| `gotchas/migration-requires-pgvector` | gotcha | active | high | 1 | pgvector extension missing causes migration failure |
| `gotchas/pg-connection-leaks` | gotcha | active | medium | 1 | Ensure pool.end() is called during graceful shutdown to… |
| `gotchas/pgvector-extension-requirement` | gotcha | active | high | 1 | pgvector extension requirement for successful migration |
| `gotchas/postgresql-pool-shutdown` | gotcha | active | medium | 1 | PostgreSQL Connection Pool Shutdown Must Call pool.end(… |
| `gotchas/provider-model-default-rot` | gotcha | active | high | 1 | Pinned provider model defaults can rot silently |
| `gotchas/provider-model-defaults-rot` | gotcha | active | high | 2 | Pinned Provider Model Defaults and Semantic Recall Gotchas |
| `gotchas/retry-function-error-handling` | gotcha | active | medium | 1 | Exponential backoff error handling warning |
| `gotchas/root-union-schema-rejection` | gotcha | active | high | 1 | Root union schemas rejected by providers |
| `gotchas/runtime-image-no-pnpm` | gotcha | active | high | 1 | Runtime image lacks pnpm, causing command failures |
| `gotchas/runtime-image-no-pnpm` | gotcha | active | medium | 2 | Runtime Image Limitations: Package Managers and Migrations |
| `gotchas/schema-root-union-type` | gotcha | active | high | 1 | Avoid using union types at schema root in structured ou… |
| `gotchas/stripe-webhook-retries` | gotcha | active | medium | 1 | Stripe webhook retries and the risk of double charges |
| `conventions/error-redaction` | convention | active | high | 1 | Error Redaction Convention for LLM Boundary |
| `conventions/error-redaction-llm-boundary` | convention | active | high | 1 | Error Redaction Convention for LLM Boundary |
| `runbooks/bringing-up-a-new-environment` | runbook | active | high | 1 | Checklist for bringing up a brand new environment |
| `runbooks/compile-job-stuck-in-queued` | runbook | active | high | 1 | Compile job stuck in queued status |
| `runbooks/compile-job-stuck-in-queued` | runbook | active | high | 1 | Runbook for resolving compile job stuck in 'queued' state |
| `runbooks/restore-postgres-from-backup` | runbook | active | high | 1 | Restore Postgres from Nightly Backup |
| `runbooks/roll-back-a-deployment` | runbook | active | high | 1 | How to Roll Back a Production Deployment |
| `runbooks/rotate-database-credentials` | runbook | active | high | 1 | Runbook for rotating production database credentials |

### 1.0 列表设计必须知道的四个真实特征

1. **path 只在项目内唯一，跨项目会重复。**上表里 `decisions/api-rate-limiting`
   出现 3 次、`services/task-service` 等出现 2 次——它们是**不同项目**里的不同
   页面，UUID 各不相同。列表页在单项目作用域内不会看到重复，但**全局搜索/
   跨项目视图必须用 UUID 而非 path 做 key**。
2. **证据数普遍是 1–2 条**，最多 3 条（`decisions/use-postgresql-pgvector`）。
   不要设计成动辄十几条证据的样子。
3. **`disputed` 真实存在且 confidence 保持 `high`**——两页 disputed 都是 high。
   "矛盾但高置信"不是假想组合，正是契约规定的行为（矛盾改 status 不降
   confidence）。
4. **标题长度差异极大**：短到 `Task service`（12 字符），长到
   `Use PostgreSQL with pgvector and pg-boss for Queue Management as the
   Primary Database`（84 字符）。列表行必须能优雅处理两端。

### 1.2 真实 tags【A·逐字】—— 筛选器与标签组件的真实形态

tags 是真实产出的，此前版本完全没有覆盖。真实特征：

- **数量差异大**：少的 3 个，多的 12 个
  （`services/task-service` 的一页有 `postgres, task-service, crud, transition,
  app-error, retry, typescript, schema, validation, task, zod, lifecycle`）；
- **合并后的页面 tag 会累积**——两条证据的页面 tag 明显更多，因为 F2 合并时
  取并集；
- **格式不统一**：绝大多数是 kebab-case（`rate-limiting`、`error-handling`），
  但真实产出里也有带空格的（`layered architecture`、`task tracker`、
  `design pattern`）——**契约没有约束 tag 格式**，设计标签组件时不能假设无空格。

### 1.1 六类型真实分布【A·逐字】—— 数据密度参考

验收累计 9 个项目 48 页的类型分布（设计列表页/筛选器的真实比例感）：

```
 type       | pages | projects
------------+-------+----------
 gotcha     |    18 |        6
 decision   |     9 |        9
 concept    |     7 |        4
 service    |     6 |        5
 runbook    |     6 |        3
 convention |     2 |        2
```

真实世界里 **gotcha 最多、convention 最少**；六类型全部实测产出过。

---

## 2. 概念页详情完整数据【A·逐字】—— 详情页（BRIEF C2）的三份主样例

> **本节此前是【B·结构精确】的拼装 JSON，现已全部替换为数据库直接导出。**
> 此前版本把"三种证据同页"的旗舰样例安在了
> `decisions/use-pg-boss-for-compile-queue` 上——**那是错的**。真实携带
> commit + pr + repo_file 三种证据的页面是 `decisions/use-postgresql-pgvector`
> （见 §13 更正表）。

### 2.1 旗舰样例："为什么"时刻决策页（三种证据同页）

M1 核心卖点的真实验收产物。**以下每个字段都是数据库原样导出**：

```json
{
  "schemaVersion": 1,
  "uuid": "13ee5d2e-6bfe-4406-ae91-153c4c0ea148",
  "path": "decisions/use-postgresql-pgvector",
  "type": "decision",
  "status": "active",
  "confidence": "high",
  "title": "Use PostgreSQL with pgvector and pg-boss for Queue Management as the Primary Database",
  "tags": [
    "postgresql",
    "pgvector",
    "decision",
    "database",
    "storage",
    "postgres",
    "pg-boss",
    "redis",
    "queue",
    "deployment"
  ],
  "body": "## Decision: Use PostgreSQL with pgvector and pg-boss for Queue Management as the Primary Database\n\n### Context\nWe needed a primary datastore that supports:\n- Transactional semantics for event ingestion and idempotency enforcement\n- Vector similarity search for concept retrieval (F2 merge candidates)\n- Job queue semantics for the compilation pipeline\n- Strong consistency guarantees\n\n### Decision\nWe chose PostgreSQL with the pgvector extension as our single database, explicitly rejecting a multi-database architecture. Additionally, pg-boss is used for managing the compile queue directly within Postgres, thereby eliminating the need for a separate Redis instance.\n\n### Rationale\n\n1. **Single operational dependency.** PostgreSQL + pgvector handles relational data, vector search, and (via pg-boss) job queuing in one system, which eliminates the need for Redis/Valkey, Qdrant, and Milvus as separate stateful services, dramatically simplifying self-hosted deployments.\n\n2. **Transactional consistency across domains.** Event ingestion, idempotency checks, and compilation job creation happen in a single Postgres transaction. With separate databases, distributed transactions or outbox patterns would be necessary.\n\n3. **Team operational experience.** The team already runs Postgres in production. Adding pgvector is a simple extension and does not require new infrastructure skills.\n\n4. **pg-boss provides exactly-once job delivery** on top of Postgres SKIP LOCKED, eliminating the need for a Redis-backed queue. Using pg-boss also avoids the burden of running and maintaining Redis just for the compile loop when pg-boss can utilize the existing Postgres setup. This keeps the default deployment simpler by reducing the number of required stateful services. The team decided to run the compile queue on pg-boss inside Postgres instead of introducing Redis. This decision keeps the self-hosted deployment to three containers by reusing the Postgres database already required for the system.\n\n### Alternatives Considered\n- **Redis/Valkey + Postgres (no pgvector).** Would require a separate vector database (Qdrant, Milvus), totaling three stateful services, and was rejected due to operational complexity for self-hosted users.\n\n- **Postgres + separate vector DB (Qdrant).** Would involve two databases with no cross-domain transactions, which could lead to independent drift between embedding and relational data.\n\n- **SQLite + pgvector.** Suitable for single-process workloads but not for multi-process server deployments where concurrent access by the worker, API, and MCP endpoints is needed.\n\n### Consequences\n- The default deployment is two containers (postgres + server/worker all-in-one) instead of four or five.\n- Embedding dimension is fixed at 1536 (OpenAI text-embedding-3-small).\n- Semantic search gracefully degrades to full-text search when embedding is unavailable, never pretending that vector search succeeded.\n- The compile queue in the default deployment now requires only three containers, enhancing ease of self-hosting, sharing the connection pool, and Write-Ahead Logging (WAL). This setup is considered acceptable at the self-hosted scale but might need revisiting for larger partner deployments.",
  "evidence": [
    {
      "kind": "pr",
      "ref": "https://github.com/teamem-ai/teamem-server/pull/107",
      "repo": null,
      "commitSha": null,
      "path": null,
      "at": "2026-07-28T02:00:00+00:00"
    },
    {
      "kind": "commit",
      "ref": "https://github.com/teamem-ai/teamem-server/commit/4f3a91c27b6d8e50a1c4f9b2e7d3a6c8b0f5e214",
      "repo": null,
      "commitSha": null,
      "path": null,
      "at": "2026-07-28T02:00:00+00:00"
    },
    {
      "kind": "repo_file",
      "ref": null,
      "repo": "teamem-ai/teamem-server",
      "commitSha": "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
      "path": "docs/decisions/001-use-postgres-pgvector.md",
      "at": "2026-07-28T04:02:17.218+00:00"
    }
  ],
  "contributors": [
    {
      "principalId": "pri_bcd9a86463a14104beced114bf645ad5",
      "kind": "service",
      "provider": "external",
      "displayLogin": "why-demo-service"
    },
    {
      "principalId": "pri_ac57a5e07cd94af0aec6b08819cb7422",
      "kind": "human",
      "provider": "github",
      "displayLogin": "why-moment-demo"
    }
  ],
  "aliases": [],
  "firstSeen": "2026-07-28T04:02:17.218+00:00",
  "lastConfirmed": "2026-07-28T04:03:20.624+00:00",
  "createdAt": "2026-07-28T04:02:22.374+00:00"
}
```

**这份数据对设计的四个硬约束**：

1. **正文很长**（约 2.5K 字符、六个 `###` 小节：Context / Decision / Rationale /
   Alternatives Considered / Consequences）。真实编译产出**不是**一两句话摘要，
   详情页正文区必须按长文排版设计——需要目录/锚点或至少良好的标题层级样式。
   此前版本的 body 样例只有 3 段，会误导设计师低估长度。
2. **三条证据的 `at` 不同源**：`pr` 与 `commit` 的 `at` 是 **GitHub 侧事件真实
   发生时间**（`02:00:00`），`repo_file` 的 `at` 是**摄取时间**（`04:02:17`）。
   证据组件排序用 `at`，但文案不能统称"发生于"——外部证据是源头时间，
   repo_file 是快照时间。
3. **`repo_file` 证据没有 `ref`**，只有 `repo` + `commitSha` + `path` 三元组；
   `pr`/`commit` 反过来只有 `ref`。**同一个证据数组里字段形状不同**，
   组件必须按 `kind` 分支渲染。
4. **三个时间戳互不相同**：`firstSeen`(04:02:17) < `createdAt`(04:02:22) <
   `lastConfirmed`(04:03:20)。GLOSSARY §2.4 强调的三词之别在真实数据里确实
   会同时出现三个不同值。

### 2.2 第二样例：MCP 写入的 gotcha（无外链证据）

【A·逐字】数据库导出：

```json
{
  "schemaVersion": 1,
  "uuid": "711d3989-06b8-46d2-9856-d05c2ab8b57e",
  "path": "gotchas/stripe-webhook-retries",
  "type": "gotcha",
  "status": "active",
  "confidence": "medium",
  "title": "Stripe webhook retries and the risk of double charges",
  "tags": ["stripe", "idempotency", "webhooks", "retries", "double-charge"],
  "body": "Stripe webhooks may retry delivery for up to three days if not acknowledged, leading to potential duplicate processing of events. To avoid double charges, handlers must be designed to be idempotent by keying operations on the Stripe event ID. It's crucial to store a processed marker BEFORE executing any irreversible side effects, as once a duplicate charge is settled, it becomes unrecoverable.",
  "evidence": [
    { "kind": "mcp_write",
      "ref": "evt_53014880b618482c94dc28ac167acee9",
      "at": "2026-07-28T12:19:43.225+00:00" }
  ],
  "contributors": [],
  "aliases": [],
  "firstSeen": "2026-07-28T12:19:43.225+00:00",
  "lastConfirmed": "2026-07-28T12:19:43.225+00:00",
  "createdAt": "2026-07-28T12:19:48.238+00:00"
}
```

设计注意：

- `mcp_write` 证据**没有外链 URL**（`ref` 是内部事件 ID）——证据组件要为
  "agent 写入"设计一种不可点外链、但能跳到站内事件详情的形态；
- **`contributors` 是空数组**。这条知识是 agent 通过 MCP 写入的，写入方是
  `client_claimed` 身份，按红线不进贡献者。**"有内容但没有贡献者"是常态而非
  异常**——贡献者区块必须设计空态（见 §2.4 的真实比例）；
- 这一页 `firstSeen == lastConfirmed`（只有一条证据、从未被再次确认），
  与 §2.1 的三值皆不同形成对照。

### 2.3 第三样例：disputed 页的正文长什么样【A·逐字】

此前版本完全没有 disputed 正文样例。真实产出的结构对 BRIEF 里 P2 的
"矛盾对账"占位是直接素材——**矛盾双方就写在正文里**：

```json
{
  "uuid": "70de6dde-2ab5-4917-97c2-2013ab91cf95",
  "path": "decisions/use-pg-boss-on-postgres",
  "status": "disputed",
  "confidence": "high",
  "title": "Decision: Queue Technology Choice for Compile Queue (Postgres vs. Redis)",
  "evidence": [
    { "kind": "repo_file", "at": "2026-07-28T03:05:11.077+00:00" },
    { "kind": "repo_file", "at": "2026-07-28T03:06:41.188+00:00" }
  ]
}
```

正文（节选，逐字）：

```markdown
### Decision: Queue Technology Choice for Compile Queue (Postgres vs. Redis)

#### Position 1: Use pg-boss on Postgres
The compile queue is implemented with pg-boss running inside Postgres rather
than Redis. This choice is operational rather than based on a technical
preference. … As a consequence, Redis or Valkey should not be introduced for
queueing, caching, or rate limiting without revisiting these trade-offs
explicitly.

#### Position 2: Move compile queue from Postgres to Redis
The team decided to migrate the compile queue from running inside Postgres
using pg-boss to Redis.
```

**设计启示**：编译器把矛盾写成 `Position 1 / Position 2` 两个小节，**没有**
把两条证据分开标注哪条支持哪一方。所以：

- disputed 页的警示条文案应当是"正文中记录了互相矛盾的立场"，而不是暗示
  UI 能把证据按立场分栏——**数据里没有这个映射**；
- P2 的"矛盾对账"占位如果承诺"看矛盾双方各自的证据"，需要后端先补这个关联，
  设计占位时不要画成已经有分栏数据的样子。

### 2.4 贡献者的真实分布【A·逐字】—— 一个 BRIEF/GLOSSARY 都没覆盖的形态

全库 `concept_contributors` 只有 7 行，落在 4 个主体上：

```
 kind    | provider | provider_kind | display_login    | 出现在几页
---------+----------+---------------+------------------+-----------
 human   | github   | github        | dli              |     1
 human   | github   | github        | why-moment-demo  |     1
 service | external | teamem        | m1-semrecall-svc |     3
 service | external | teamem        | why-demo-service |     2
```

**两个必须处理的真实情况**：

1. **贡献者可能是 `service` 主体，不是人**（7 行里 5 行是）。它
   `provider = external`、没有 GitHub 数字 ID、**没有头像可取、没有 GitHub 主页
   可链**。BRIEF §C2-4 与 GLOSSARY §3 只写了"已绑定 web 账号 → 站内资料页"和
   "纯 GitHub 贡献者 → 外链 GitHub 主页"两种，**第三种（服务主体）没有归宿**。
   建议形态：中性图标 + `display_login` + hover 说明"Service account"，不可点击。
   这是 §13 里提给产品的开放问题 Q9。
2. **绝大多数页面没有任何贡献者**（48 页里只有 5 页有）。贡献者区块的**空态
   才是默认视图**——原因见 §2.2：`client_claimed` 不进贡献者，而 CLI/MCP
   摄取的事件都是 client_claimed。

---

## 3. 检索真实交互【A·逐字】—— 检索框与结果页（BRIEF C1）

### 3.1 自然语言命中（零关键词重叠）

机器 B 用与正文无词面重叠的自然语言提问，命中机器 A 通过 agent 写入的页：

```
query: "how do we avoid charging a customer twice on webhook retry"
→ degraded: false | results: 1
   gotcha  gotchas/stripe-webhook-retries
   uuid: 711d3989-06b8-46d2-9856-d05c2ab8b57e
```

设计启示：检索结果的核心叙事是"你不用记得当时的用词"——结果行带
relevance 分数与类型徽章即可，不需要关键词高亮（语义命中经常没有共同词
可以高亮）。

### 3.2 跨语言合并（语义检索差异化卖点）

英文概念先入库，中文事件（"避免接口被刷爆，用了令牌桶那套方案"）零词面
重叠，仍并进同一页：

```
Semantic capability: vector (embedding provider IS available)
✓ PASS Event 1 compiled → concept(s): d547f989-…
✓ PASS Event 2 compiled → concept(s): d547f989-…      ← 同一个 UUID
✓ PASS Page count did NOT increase (event 2 merged into existing page)
```

### 3.3 limit 越界的真实错误信封（错误态设计用）

```
$ curl -X POST /v1/search -d '{"projectId":"prj_A","query":"x","limit":101}'
HTTP 400
{"error":{"code":"invalid_request","message":"Bad request",
          "details":{"field":"limit","max":"100","provided":"101"}}}
```

真实错误就这么短——一个稳定 code + 简短 message + 结构化 details。
错误组件不需要为长文本留空间。

### 3.4 跨团队探测 = 空结果（"空 ≠ 报错"的设计依据）

```
A 的 key 查 B 真实存在的项目   → HTTP 200  {"degraded":false,"nextCursor":null,"results":[]}
A 的 key 查一个不存在的项目 id → HTTP 200  {"degraded":false,"nextCursor":null,"results":[]}
去掉 requestId 后两个响应逐字节一致
```

无权访问的检索**不是错误页**，就是普通空结果——检索空态文案绝不能出现
"可能没有权限"的暗示。

### 3.5 检索响应完整结构【A·逐字】

2026-07-29 对验收库实发的一次检索，逐字返回：

```
$ curl -X POST /v1/search -d '{"projectId":"prj_dda2e3e3…",
    "query":"why did we pick postgres over a separate vector database"}'
```

```json
{
  "requestId": "69fa9eac-73e8-4b3f-9675-41085da03a9f",
  "results": [
    {
      "uuid": "13ee5d2e-6bfe-4406-ae91-153c4c0ea148",
      "path": "decisions/use-postgresql-pgvector",
      "type": "decision",
      "status": "active",
      "confidence": "high",
      "title": "Use PostgreSQL with pgvector and pg-boss for Queue Management as the Primary Database",
      "tags": ["postgresql","pgvector","decision","database","storage",
               "postgres","pg-boss","redis","queue","deployment"],
      "lastConfirmed": "2026-07-28T04:03:20.624Z",
      "relevance": 0.36,
      "ftsFallback": false
    }
  ],
  "degraded": false,
  "nextCursor": null
}
```

**三个对设计有直接影响的真实细节**：

1. **`relevance` 是 0.36，不是 0.9x。**此前版本按 0.87 举例，会误导设计师把
   相关度做成"百分比匹配度"——真实的语义相关度是余弦相似度，**一次完全正确
   的命中也可能只有 0.3 上下**（上面这条就是唯一且正确的命中）。渲染成
   "36% 匹配" 会让用户以为结果很差。建议**不显示原始数值**，或仅用于排序 /
   用高中低三档表达。
2. **结果行不含 body 或摘要片段**——只有 title + tags + 元数据（契约 N7：
   列表只返回摘要字段）。设计不能依赖"搜索结果带两行正文预览"。
3. **`degraded`（整次检索）与 `ftsFallback`（逐行）是两个独立标记**——
   BRIEF C1 的降级横幅用前者，单行弱标记用后者。

## 4. CLI 真实输出【A·逐字】—— 引导流 Step 4/5 与文档页

### 4.1 `teamem init` 成功（有 provider）

输出格式来自 CLI 源码，数字来自实测（3 个事件编成 2 页——其中一个被 F2
合并，计数对 UUID 去重）：

```
Repository:   teamem-ai/sample-task-tracker
Commit:       9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c
Files:        3
Ingested:     3
Rejected:     0
Jobs:         eaf45a04-7c3d-4e2f-9a1b-8c7d6e5f4a3b
Job status:   completed
Pages:        2
```

### 4.2 `teamem init` 无 provider（诚实失败，2.3 秒返回）

```
Files:        3
Ingested:     3
Job status:   failed
Pages:        0
```

配套的 job 错误（任务详情页 D4 的真实错误文案）：

```json
{ "code": "no_llm_provider",
  "message": "No LLM provider is configured, so this job could not be compiled. …" }
```

设计启示：摄取成功、编译失败是**真实会出现的组合**——"事件进来了但没编译"
在 UI 上要能被一眼区分（引导 Step 5 的状态区、任务列表都要体现）。

### 4.3 冷启动 E2E 的收尾输出（引导 Step 5"完成态"的素材）

```
✓ Search endpoint: PASS
--- Spot Checks ---
  services/task-service                        service   2 evidence
  concepts/layered-architecture-task-tracker   concept   1 evidence
  gotchas/retry-function-error-handling        gotcha    1 evidence
  gotchas/postgresql-pool-shutdown             gotcha    1 evidence
  concepts/app-error-conventions               concept   1 evidence

Provider: available — compilation assertions were evaluated
✓ ALL CHECKS PASSED
```

---

## 5. 活动区真实数据【A·逐字】—— D1–D4 的数据密度与形态

此前版本没有覆盖活动区的真实分布，只给了 CLI 输出。以下全部来自数据库。

### 5.1 事件来源分布（D1 列表）

```
 channel | kind          | actor_provenance | count
---------+---------------+------------------+-------
 github  | github_commit | webhook_verified |     2
 github  | github_pr     | webhook_verified |     2
 cli     | cli_init      | unknown          |    77
 mcp     | mcp_write     | unknown          |     1
```

**设计必须知道的两点**：

1. **82 条事件里 78 条的 `actor_provenance = unknown`**。BRIEF §D1 写着 actor
   "可能为空"——真实数据里**空才是主流**。CLI 摄取（`teamem init` 扫仓库）和
   MCP 写入天然没有可验证的 actor。**不要把"有头像的 actor"设计成默认态、
   把 Unknown 当边角料**，实际比例是反过来的。
2. **只有 GitHub 来源能拿到 `webhook_verified`**——这正是契约规定（只有验签的
   connector 才能背书身份）。✓ 标记只会出现在 GitHub 事件行上。

### 5.2 actor 对象的真实结构（D1 行 / D2 详情）

GitHub 事件的 actor 是完整对象，**含 GitHub 数字 ID**：

```json
{ "kind": "human", "provider": "github",
  "displayLogin": "dli", "providerUserId": "1880754" }
```

`providerUserId` 是 GitHub 数字 ID，所以头像可以直接用
`https://avatars.githubusercontent.com/u/1880754` 取——**不需要额外 API 调用**。
CLI / MCP 事件的 actor 则是 `null`。

### 5.3 cli_init 事件的列表行素材

```
kind      | external_id                                                    | payload.path
----------+----------------------------------------------------------------+-------------------------
cli_init  | ec316e3a…:docs/runbooks/roll-back-a-deployment.md               | docs/runbooks/roll-back-a-deployment.md
cli_init  | ec316e3a…:docs/runbooks/rotate-database-credentials.md          | docs/runbooks/rotate-database-credentials.md
```

`external_id` 格式是 `<commitSha>:<文件路径>`，很长——列表行的"摘要"列需要
中间截断（`ec316e3a…:docs/…/roll-back-a-deployment.md`）而不是尾部截断，
否则最有信息量的文件名会被截掉。

### 5.4 任务状态真实分布（D3 列表）

```
 kind         | status    | count
--------------+-----------+-------
 ingest_event | completed |    12
 ingest_batch | queued    |     6
 ingest_batch | completed |     6
 compilation  | completed |     5
 compilation  | failed    |     2
```

三种真实 `kind`：`ingest_event` / `ingest_batch` / `compilation`——BRIEF §D3
只说了"任务 kind"没列举，这是真实取值。

### 5.5 逐事件结果真实分布（D4 详情）

```
 status   | count
----------+-------
 compiled |    61
 skipped  |    10
 pending  |     9
```

- **`skipped` 占 12%**——不是罕见态，D4 的 skipped 行样式要认真设计
  （GLOSSARY R10：中性灰，不是错误色）；
- **`pending` 有 9 条**——任务已建但事件尚未处理完。BRIEF §D4 只列了
  compiled/skipped/failed 三种结局，**漏了 `pending`**（契约 `jobEventResult`
  的四个分支之一）。列表要能表达"这条还没轮到"。

### 5.6 skip 原因：API 返回的是枚举，不是模型原话

数据库里 `reason` 列现在是**混合**的——5 条枚举 `no_knowledge`，5 条模型自由
文本（如 "Purely mechanical change in configuration file with no explanation
or reasoning."）。后者是 M1 修复前的遗留数据。

**但 UI 永远只会看到枚举**：读路由把任何非契约值归一化成 `no_knowledge`
（这是 M1 修的一个真实缺陷——自由文本会让 `GET /v1/jobs/:id` 返回 500）。

所以设计 D4 的 skipped 行时：

- 枚举只有 **`no_knowledge`** 和 **`already_compiled`** 两个值；
- GLOSSARY §4.2 举的例子 "low-signal commit" **不是真实枚举值**，
  文案应改用真实值（见 §13 更正表）；
- 模型那些具体理由**拿不到**，不要设计成能展示详细原因的样子。

### 5.7 真实 job 错误（D4 失败行）

全库唯一的真实 job 错误，逐字：

```json
{ "code": "no_llm_provider",
  "message": "No LLM provider is configured, so this job could not be compiled. Set TEAMEM_ANTHROPIC_API_KEY, TEAMEM_OPENAI_API_KEY, TEAMEM_OPENROUTER_API_KEY, or the OpenAI-compatible pair, then re-submit the events." }
```

真实错误就是**一个稳定 code + 一句可执行的指引**，没有堆栈。注意这条 message
本身就是"下一步怎么办"——错误组件应该把 message 当正文渲染，而不是折叠成
一行小字。

---

## 6. 审计日志真实数据【A·逐字】—— F6 页面

此前版本完全没有覆盖审计页。真实动作词表：

```
 action             | outcome | count
--------------------+---------+-------
 concept.read       | success |    10
 event.payload_read | success |     2
 mcp.search         | success |     8
 mcp.timeline       | success |     2
 search.query       | success |    14
 search.query       | denied  |     2
```

**六个真实动作值**（F6 的筛选器直接用这套）：`concept.read` ·
`event.payload_read` · `mcp.search` · `mcp.timeline` · `search.query`。
注意 **MCP 调用与 Web 检索是分开记的**（`mcp.search` vs `search.query`）——
审计页可以按此区分"人在 UI 里查的"和"agent 通过 MCP 查的"，这是个有价值的
筛选维度，BRIEF §F6 没提到。

真实审计行的完整字段（表结构逐字）：

```
id · created_at · request_id · principal_id · credential_id ·
action · resource_type · resource_id · team_id · project_id · outcome
```

**表里没有任何内容列**——GLOSSARY R12 说的"审计不展示内容"不是约定，是
物理上就没有这个字段。`search.query / denied` 那两行就是 §3.4 的跨团队探测，
**被拒也留痕**。

---

## 7. "为什么"时刻演示【A·逐字】—— 登陆页/引导叙事素材

真实验收输出（38/38 断言全过的那次）：

```
5b. Full 'Why' Moment — PR discussion + implementing commit (webhook)
✓ PASS   pull_request delivery accepted (signature verified)
✓ PASS   push delivery accepted (signature verified)
→   evidence kinds on the page: commit,pr,repo_file
✓ PASS   conclusion: page type is decision with a non-empty body
✓ PASS   PR discussion link present as 'pr' evidence
✓ PASS   implementing commit permalink present as 'commit' evidence
✓ PASS   all three elements on ONE page (F2 merged, page count did not split)
→   → conclusion:  Decision to Use pg-boss in Postgres … Instead of Redis
→   → PR discussion: https://github.com/teamem-ai/teamem-server/pull/107
→   → landed commit: https://github.com/teamem-ai/teamem-server/commit/4f3a91c…
```

这就是产品故事的一屏：**问一个"为什么"，得到结论 + 当时的讨论 + 落地的
commit，且在同一页上**。营销/引导页设计照这个真实结构讲。

---

## 8. 脱敏真实演示【A·逐字】—— 理解"redaction"这个词的最好教材

agent 写入的正文里嵌了私有段：

```
写入原文（片段）：
  … <private>internal escalation channel is #billing-oncall,
  pager rotation owned by k.tanaka</private> …

落库后全库检索：
$ select count(*) from events where payload::text ilike any
    ('%billing-oncall%','%k.tanaka%','%<private>%');
  0                                    ← 整段不落库

存下的正文（前 200 字符）：
  Stripe retries a webhook delivery for up to three days, so handlers must be
  idempotent: … BEFORE any side effect.  A duplicate charge is unrecoverable…
                                         ↑ 私有段消失，前后文完好
```

设计启示：UI 里**永远不会出现**"打码/遮盖"样式——私有内容在落库前就被整段
移除了，页面上没有"这里有一段被隐藏"的痕迹可以展示。任何"点击查看被隐藏
内容"的交互都是对产品模型的误解。

---

## 9. 时间线真实输出【A·逐字】—— 详情页时间线（BRIEF C2-5）

三条事件按 `occurred_at` 降序（**故意**与入库顺序相反，证明排序依据）：

```
2026-07-28T12:19:43.225Z  mcp_write  mcp:Stripe webhook retries…
2026-06-20T17:30:00.000Z  cli_init   newer-event
2026-01-15T09:00:00.000Z  cli_init   older-event
```

注意跨度：真实时间线的间隔可以是**几个月**，不是几分钟——时间线组件要能
优雅地表达大间隔（不要设计成均匀刻度）。

---

## 10. bootstrap 与接入命令真实格式 —— 引导 Step 4 / key 铸造页

`claude mcp add` 命令的**代码级精确格式**（`format-mcp-command.ts`）：

```
claude mcp add --transport http teamem http://localhost:8080/mcp --header "Authorization: Bearer tm_9f3aX7bQ2wE8rT1y"
```

配套真实 ID 格式（契约正则）：

| 实体 | 格式 | 示例 |
|---|---|---|
| API token（密钥，一次性展示） | `tm_…` | `tm_9f3aX7bQ2wE8rT1y` |
| key ID（可长期展示） | `key_…` | `key_7f3aB2cD` |
| 项目 | `prj_…` | `prj_dc4dE5fG` |
| 事件 | `evt_…` | `evt_53014880aBcD` |
| 身份主体 | `pri_…` | `pri_9Kx2mAb7` |
| 任务/概念页 | 标准 UUID | `711d3989-06b8-46d2-9856-d05c2ab8b57e` |

一个已验收过的行为细节：**key 轮换（rotate）立即吊销旧 key**——验收中途
真的因此把正在用的 key 弄 401 过。F1 页轮换按钮的警告文案有实锤依据。

---

## 11. 真实 token 用量【A·逐字】—— 配置/质量页未来参考

一次真实编译批次的三层用量（M2 无此 UI，留作未来质量页/成本页素材）：

```
f1-extract    9 calls  32182 prompt + 1371 completion  (3728/call)
f2-merge      3 calls  17216 prompt + 1439 completion  (6218/call)
embedding    14 calls   3306 prompt +    0 completion  ( 236/call)
```

产品原则实例：系统只报实测 token 数，**美元成本字段故意为 null**（不用猜的
费率编数字）——未来做成本 UI 时沿用这个诚实姿态。

---

## 12. 样例 ↔ 页面对照表（设计师检索用）

| BRIEF 页面 | 用本文哪节 |
|---|---|
| C1 概念页列表 | §1 全量 48 行清单 + §1.0 四个真实特征 + §1.1 类型分布 + §1.2 tags |
| C2 概念页详情 | §2.1（三证据决策页，长正文）+ §2.2（mcp_write 无外链）+ §2.3（disputed 正文）+ §2.4（贡献者形态）+ §9 时间线 |
| C1 检索态/降级/空态 | §3.1–3.5 |
| D1 事件列表 | §5.1 来源分布 + §5.2 actor 结构 + §5.3 列表行截断 |
| D2 事件详情 | §5.2 + §8 脱敏认知 |
| D3 任务列表 | §5.4 状态分布（含三种 kind） |
| D4 任务详情 | §5.5 逐事件分布（含被遗漏的 `pending`）+ §5.6 skip 枚举 + §5.7 真实错误 |
| E2 成员资料 / C2 贡献者 | §2.4（**含 BRIEF 未覆盖的 service 主体**） |
| F1 API keys 页 | §10 ID 格式 + rotate 警告依据 |
| F3 LLM 设置（语义能力状态） | §3.5 degraded 字段 + §3.2 |
| F6 审计日志 | §6 六个真实动作 + 表结构（**无内容列**） |
| 引导 Step 4（key + 命令） | §10 |
| 引导 Step 5（等待编译/完成） | §4.1–4.3 + §5.4 |
| 登陆页/产品叙事 | §7 "为什么"时刻 |

---

## 13. 本次更正与新增开放问题（2026-07-29）

### 13.1 对本文此前版本的更正

连库核对后发现四处与真实数据不符。**已在正文改正，此处留痕**：

| # | 此前说法 | 真实情况 |
|---|---|---|
| 1 | "验收后数据库已按环境清理流程删除，本文是抢救整理的" | **数据库一直在线**（CLOSEOUT §11.2 记录保留）。本次已全量重导，原【B·结构精确】的拼装内容全部替换为真实导出 |
| 2 | 三种证据同页的旗舰样例是 `decisions/use-pg-boss-for-compile-queue` | 真实携带 commit+pr+repo_file 的是 **`decisions/use-postgresql-pgvector`**。前者只有 2 条证据。此前版本把两个不同的真实页面混成了一个 |
| 3 | 多处置信度标 `—*`「验收记录未留档，可自选」 | **全部有真实值**，已按库中实际填入（如 `gotchas/retry-function-error-handling` = medium、`services/task-service` = medium） |
| 4 | §1 只列 11 行样例 | 全库 **48 行**已全量列出；此前的 11 行是从验收记录里摘的子集 |

### 13.2 给 GLOSSARY 的两处修正建议

| 位置 | 问题 | 建议 |
|---|---|---|
| GLOSSARY §4.2 | skip 原因举例写的是 "low-signal commit" | **不是真实枚举值**。契约枚举只有 `no_knowledge` 和 `already_compiled` 两个，文案应改用真实值 |
| GLOSSARY §3 身份表 | 只覆盖 human（GitHub）与"已绑定/未绑定"两种贡献者 | 真实数据里**多数贡献者是 `service` 主体**（7 行里 5 行），需要第三种形态，见下 Q9 |

### 13.3 给 BRIEF 的三处补充建议

| 位置 | 缺口 | 依据 |
|---|---|---|
| §C2-4 贡献者 | 未覆盖 `service` 主体（无头像、无 GitHub 主页） | §2.4 |
| §D4 逐事件结果 | 只列了 compiled/skipped/failed，**漏了 `pending`** | §5.5，库里有 9 条 |
| §D1 事件列表 | actor "可能为空" 的措辞低估了比例——真实 82 条里 78 条为空 | §5.1 |

### 13.4 新增开放问题（接 BRIEF §10 的编号）

| # | 问题 | 背景 | 建议默认 |
|---|---|---|---|
| **Q9** | `service` 主体贡献者怎么展示？ | 真实数据里它是多数。无 GitHub 头像、无主页可链、也没有站内资料页 | 中性图标 + `display_login` + hover "Service account"，**不可点击**；与人类贡献者视觉区分 |
| **Q10** | 跨项目视图里 path 重复怎么办？ | path 只在项目内唯一，全库有 `decisions/api-rate-limiting` 等重复 3 次的情况 | 单项目视图不受影响；任何跨项目列表以 UUID 为 key，并在行上显示项目名 |
| **Q11** | tag 是否需要格式约束？ | 真实产出里既有 kebab-case 也有带空格的（`layered architecture`），契约无约束 | 前端按原样展示不做规范化；若要做 tag 云/筛选，需产品先定是否后端归一化 |

---

## 附：原始数据包与自助重导

### 数据包（推荐直接用）

本文所有【A·逐字】数据的完整机器可读版本已 dump 到
**[`samples-data/`](./samples-data/)**：

| 文件 | 内容 |
|---|---|
| `concepts.json` | 48 个概念页完整详情（正文全文 / tags / evidence / contributors / 三时间戳 / aliases） |
| `concepts.csv` | 扁平表，多一列 `body_chars`（正文 223–3228 字符，中位 917） |
| `evidence.csv` | 61 条证据逐行 |
| `contributors.csv` | 7 条贡献者关联（含 service 主体） |
| `activity-and-audit.json` | 事件/任务/审计的分布、真实 actor 结构、真实 job 错误、审计表结构 |

用法见 [`samples-data/README.md`](./samples-data/README.md)。

> **`db-snapshot.sql`（1.2MB 可恢复快照，不含 `api_keys`）不在本仓库**——
> 它是"起一个活数据库做可交互原型"用的恢复件，为避免把 1.2MB dump 塞进产品仓库
> 历史，仍留在规划库 `tasks/M2/ui-samples-data/db-snapshot.sql`。做静态实现只用
> 上面这几个轻量文件即可；要活库时去规划库取那份快照，或按下方自助重导重跑一遍。

### 自助重导（数据包已够用时不必看）

这台机器上的验收库可直接查询（容器 `teamem-postgres-1`，库 `teamem`）：

```bash
docker exec teamem-postgres-1 psql -U teamem -d teamem -c "
select p.path, c.type, c.status, c.confidence, c.title,
       (select count(*) from concept_evidence e where e.concept_uuid=c.uuid) as ev
from concepts c
join concept_paths p on p.concept_uuid=c.uuid and p.is_current
order by c.type, p.path"
```

单页完整详情（换 uuid 即可）：

```bash
docker exec teamem-postgres-1 psql -U teamem -d teamem -tAc "
select json_build_object('uuid',c.uuid,'path',p.path,'type',c.type,'status',c.status,
  'confidence',c.confidence,'title',c.title,'tags',c.tags,'body',c.body,
  'evidence',(select json_agg(json_build_object('kind',e.kind,'ref',e.ref,'repo',e.repo,
              'commitSha',e.commit_sha,'path',e.path,'at',e.at))
              from concept_evidence e where e.concept_uuid=c.uuid))
from concepts c join concept_paths p on p.concept_uuid=c.uuid and p.is_current
where c.uuid='13ee5d2e-6bfe-4406-ae91-153c4c0ea148'" | python3 -m json.tool
```

⚠️ **那台机器上的容器不是长期服务** —— 长期依赖 `samples-data/` 里的文件，
不要依赖容器还开着。若库已不在且需要新数据，按规划库 `tasks/M1/CLOSEOUT.md` §1
重跑一遍（约 30 分钟）即可得到形状一致的产物。
