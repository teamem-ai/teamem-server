# teamem 术语表 + 文案对照 —— 给 UI 设计师的用词手册

> **配套文档**：[UI-BRIEF.md](./UI-BRIEF.md)（页面清单）。BRIEF 说"设计什么"，
> 本文说"用什么词、怎么说"。
>
> **怎么用**：
> 1. 画任何页面前，先扫一遍 §1-§5，理解每个会出现在界面上的名词到底指什么；
> 2. 写 microcopy 时直接抄 §6 的标准文案表（英文为主稿语言，中文为对照）；
> 3. 提交设计稿前，用 §7 文案红线自查一遍——那里每一条都是产品契约或
>    工程红线的直接翻译，不是风格偏好，**违反了会被验收打回**；
> 4. 拿不准语气时看 §8。
>
> **语言策略**（对应 BRIEF §10-Q4 的建议默认）：界面英文优先（产品面向全球
> 开源发布），本文所有术语给出 EN / ZH 对照；若后续拍板双语，ZH 列即为译文基准。

---

## 1. 产品核心词汇（讲故事的词）

| 术语 (EN) | 中文 | 一句话定义 | 设计师需要知道的 |
|---|---|---|---|
| **teamem** | — | 产品名，全小写 | 永远小写，包括句首；不写 TeamMem/Teamem |
| **portal** | 门户 | 自托管的服务端本体（含本次要设计的 Web UI） | 对用户说"your teamem portal"，指他们自己部署的这套系统 |
| **concept page** | 概念页 | 产品的核心产物：一条结构化的团队知识，带类型、证据、贡献者 | UI 上可简称 **page / 页面**；别叫 document/note/memo——它不是人写的文档 |
| **compile / compilation** | 编译 | 把原始开发事件蒸馏成概念页的过程（LLM 驱动） | **产品的核心隐喻，全站统一用这个词**；不要写成 generate/analyze/AI 处理 |
| **evidence** | 证据 | 概念页的出处：commit、PR、issue、评论、仓库文件的不可变链接 | 全产品最重要的信任词；每条知识必有 ≥1 条证据 |
| **the "why" moment** | "为什么"时刻 | 核心卖点场景：问"为什么 X 用了 Y"，得到结论+讨论链接+落地 commit | 营销/引导文案可用；产品功能区不用这个词 |
| **knowledge base** | 知识库 | 一个项目内全部概念页的集合 | 导航项可用 Knowledge |
| **agent** | — | 用户的 AI 编程助手（Claude Code 等） | 不翻译成"代理"；中文语境也直接写 agent |
| **MCP** | — | Model Context Protocol——agent 连接 teamem 的标准协议 | 界面上不解释缩写，目标用户都认识；首次出现可 hover 提示 |
| **`teamem init`** | — | CLI 命令：扫描一个仓库的存量代码推给 portal，解决冷启动 | 命令一律等宽字体、可复制 |
| **SessionStart injection** | 会话自动注入 | agent 每次开新会话时自动获得团队知识摘要 | M2 新能力，对手做不到，引导文案可强调 |
| **progressive disclosure** | 渐进披露 | agent 检索的分层设计：先给索引行，需要时再取全文 | 内部概念，**不出现在 UI 文案里** |
| **self-hosted** | 自托管 | 用户在自己的机器上跑整套系统，数据不出门 | 信任叙事的支点，登录页/引导可用 |
| **GitHub App** | — | operator 在 GitHub 上创建的**单一**接入点：同时提供登录用的 user-to-server OAuth 和摄取用的 webhook/installation（2026-07-29 拍板合并，之前误以为是两个独立对象） | A1 登录依赖它已在部署前配好；引导 Step 3 和设置 F2 都是在管理**同一个** App 的 installation 范围，文案不要写成"连接 GitHub"这种听起来像重新授权的措辞——用"选择仓库/管理访问范围" |

---

## 2. 概念页的字段术语（C1 列表 / C2 详情页会出现的每个词）

### 2.1 六种类型（type badges）—— 全站最高频徽章

| 值 | EN 标签 | ZH 标签 | tooltip（EN 建议稿） |
|---|---|---|---|
| `decision` | Decision | 决策 | A choice the team made — with the reasoning and discussion behind it |
| `gotcha` | Gotcha | 坑 | A pitfall or surprising behavior the team learned the hard way |
| `convention` | Convention | 约定 | An agreed way of doing things in this team or codebase |
| `runbook` | Runbook | 操作手册 | Step-by-step procedure for an operational task |
| `service` | Service | 服务 | What a service or component is, does, and how it fits in |
| `concept` | Concept | 概念 | A domain term or idea the team needs a shared understanding of |

### 2.2 四种状态（status badges）

| 值 | EN 标签 | ZH 标签 | tooltip（EN 建议稿） | 视觉基调 |
|---|---|---|---|---|
| `active` | Active | 有效 | Current team knowledge | 默认/绿系，最弱视觉 |
| `superseded` | Superseded | 已取代 | Replaced by newer knowledge | 中性灰，非错误 |
| `disputed` | Disputed | 有矛盾 | Conflicting evidence exists — needs reconciliation | 警示（橙/黄），要醒目 |
| `needs-review` | Needs review | 待复核 | Flagged for human review | 提示（蓝/紫） |

> ⚠️ `disputed` 的语义：出现了**互相矛盾的证据**。它是状态变化，**不是置信度
> 降低**——文案绝不能写成 "low confidence"，要写 "conflicting evidence"。
> 这是冻结契约的明文规定。

### 2.3 三档置信度（confidence）

| 值 | EN | ZH | 说明 |
|---|---|---|---|
| `high` | High confidence | 高置信 | 多次证据确认 |
| `medium` | Medium confidence | 中置信 | 正常水平 |
| `low` | Low confidence | 低置信 | 证据单薄，弱视觉即可，不是警告 |

### 2.4 三个时间字段——**最容易写错文案的地方**

| 字段 | EN 标签 | ZH 标签 | 语义 | 禁止写法 |
|---|---|---|---|---|
| `last_confirmed` | Last confirmed | 上次确认 | **新证据再次证实**该知识（或人工确认）的时间；普通改写**不会**刷新它 | ❌ Updated / 更新于 |
| `created` | Created | 创建于 | 概念页首次编译产出的时间 | — |
| `occurred_at` | Occurred | 发生于 | 源头事件在 GitHub/CLI 真实发生的时间（时间线用这个排序） | ❌ Created / Ingested |

### 2.5 其他字段

| 术语 | EN | ZH | 说明 |
|---|---|---|---|
| `path` | Path | 路径 | 人类可读定位符，如 `backend/auth/jwt-rotation`；全小写、`/` 分隔；**可改名** | 等宽字体，可复制 |
| alias | Alias | 历史路径 | 改名后旧 path 仍可访问，指向同一页 | 详情页收起展示 |
| UUID | — | — | 概念页的**真正身份**（path 只是门牌） | 仅详情页"复制 UUID"处出现 |
| tag | Tag | 标签 | 自由标签，可筛选 | — |
| internal link | — | 内链 | 正文里 `teamem://concept/<uuid>` 渲染成站内跳转 | 与外链（GitHub）视觉区分 |

---

## 3. 身份词汇——五个词的区别（本表是全文档最重要的一节）

设计师最容易混的五个词。它们在数据上是不同实体，混用会直接做错交互：

| 术语 | EN | 是什么 | 出现在哪 | 关键区别 |
|---|---|---|---|---|
| **user** | User | 通过 GitHub OAuth 登录过 Web UI 的账号 | 用户菜单、成员管理 | 有登录态的才是 user |
| **member** | Member | 加入了某个团队的 user + 一个角色 | 成员页、角色管理 | user 可以属于多个团队，各有角色 |
| **principal** | — | 系统记账用的"身份主体"：可能是 GitHub 用户、也可能是服务账号；**不一定登录过 UI** | 不直接出现在 UI 文案 | 一个只提交过代码、从没登录过 portal 的同事，是 principal 但不是 user |
| **contributor** | Contributor | 出现在某张概念页上的**可信**贡献者 | 概念页详情、成员资料 | 只有 `webhook_verified` 的 actor 才能成为 contributor |
| **actor** | Actor | 某个**事件**声称的行为人，**可能为空** | 事件列表/详情 | 是"事件说这是谁干的"，不是系统认证过的身份 |

UI 落地规则：
- 概念页 contributor **已绑定 web 账号** → 站内成员资料页；**未绑定**（纯
  GitHub principal）→ GitHub 头像 + login，外链其 GitHub 主页，hover
  提示 "Not a portal member yet"（BRIEF §10-Q6 默认）；
- ⚠️ **第三种：`service` 主体**（`provider = external`，如 `teamem init` 用的
  服务账号）。它**没有 GitHub 头像、没有主页可链、也没有站内资料页**。
  真实验收数据里它是贡献者的**多数**（7 条里 5 条）——
  见 [UI-SAMPLES §2.4](./UI-SAMPLES.md)。建议：中性图标 + `display_login` +
  hover "Service account"，**不可点击**，与人类贡献者视觉区分（BRIEF §10-Q9）；
- **贡献者为空是常态**：48 页里只有 5 页有贡献者，因为 `client_claimed`
  身份（CLI/MCP 摄取）按红线不进贡献者。贡献者区块的**空态才是默认视图**；
- 事件 actor 为空 → 显示 **Unknown / 未知**，配中性占位图形；**绝不**显示
  "System"或编造头像（红线：未知保持未知，不伪造身份）；
- actor 可信度双态：`webhook_verified`（GitHub 验签背书，✓ 标）/
  `client_claimed`（客户端自称，无标）。tooltip：
  - verified: "Identity verified by GitHub webhook signature"
  - claimed: "Self-reported by the client — not verified"

### 3.1 四个角色

| 值 | EN | ZH | 一句话（用于角色下拉的描述行） |
|---|---|---|---|
| `owner` | Owner | 所有者 | Full control, including destructive actions and role management |
| `admin` | Admin | 管理员 | Manage keys, connectors, LLM settings and audit |
| `member` | Member | 成员 | Search, read payloads, preview agent context |
| `viewer` | Viewer | 只读者 | Browse knowledge and job activity, read-only |

---

## 4. 摄取与编译流水线术语（活动区 D1-D4 用）

| 术语 | EN | ZH | 说明 |
|---|---|---|---|
| event | Event | 事件 | 摄取进来的一条原始开发活动 |
| ingest / ingestion | Ingest | 摄取 | 事件进入系统的动作；不要写 upload/import |
| source | Source | 来源 | 六种：GitHub push / PR / issue / comment、`cli_init`、`mcp_write` |
| redaction | Redaction | 脱敏 | 落库前自动移除 `<private>...</private>` 段落；UI 见到的 payload 永远是脱敏后的 |
| payload | Payload | — | 事件的原始内容（脱敏后）；读取需 `read:payload` 权限且**被审计** |
| job | Job | 编译任务 | 一次编译工作单元 |
| queue / worker | — | 队列/工作进程 | 内部词，UI 只说 job 状态，不提 pg-boss/worker |
| duplicate | Duplicate | 重复投递 | 同一事件的**无害重放**，系统返回原结果；中性事实，不是错误 |
| conflict | Conflict | 幂等冲突 | 同一投递身份但**内容变了**——这才是异常（409） |
| skip | Skipped | 已跳过 | 编译器判定事件是噪音（如 "fix typo" commit），**健康行为不是失败**；带原因 |
| merge | Merge | 合并 | F2 把新知识并进已有概念页（更新而非新建）；UI 可说 "merged into an existing page" |
| semantic search | Semantic search | 语义检索 | 换说法/跨语言也能命中的检索（向量模式） |
| keyword search / FTS | Keyword search | 关键词检索 | 语义不可用时的降级模式 |
| degraded | — | 降级 | 语义能力缺失的状态，**必须明示**（见 §7-R2） |

### 4.1 任务状态（job status badges）

| 值 | EN | ZH | 视觉 |
|---|---|---|---|
| `queued` | Queued | 排队中 | 中性 |
| `processing` | Processing | 编译中 | 进行态（可带动效） |
| `completed` | Completed | 已完成 | 成功 |
| `failed` | Failed | 失败 | 错误 |
| `cancelled` | Cancelled | 已取消 | 中性灰 |

### 4.2 逐事件结果（job 详情内）

| 值 | EN 文案模式 | 说明 |
|---|---|---|
| `compiled` | Compiled → *linked page title* | 链到产出/更新的概念页 |
| `skipped` | Skipped — *reason* | 原因是枚举值，**只有两个真实取值**：`no_knowledge`（无可提取知识）与 `already_compiled`（已编译过）。不是自由文本，也拿不到模型的具体理由（读路由会把任何非契约值归一化）。此前本行举例的 "low-signal commit" 不是真实枚举值 — 见 [UI-SAMPLES §5.6](./UI-SAMPLES.md) |
| `failed` | Failed — *sanitized error* | 错误已脱敏，就一两行，不会有长堆栈 |

---

## 5. 治理与安全术语（设置区 F、审计 F6 用）

| 术语 | EN | ZH | 说明 |
|---|---|---|---|
| API key | API key | — | 接入凭证。**两段式**：`key_...` 是 key 的 ID（可展示，不是密钥）；`tm_...` 是明文 token（**只在铸造时显示一次**） |
| mint | Mint a key | 铸造 | 创建 key 的动词；比 create 更准确（产品既有用词） |
| revoke | Revoke | 吊销 | **立即生效**——正在使用该 key 的请求马上 401 |
| rotate | Rotate | 轮换 | 铸新 + 吊销旧的组合动作；警告文案必须提"旧 key 立即失效" |
| scope | Scope | 权限范围 | key 的数据面权限：`read` / `read:payload`（含 read）/ `write`；key 永远没有管理权限 |
| all projects | All projects | 所有项目 | 团队级 key 的显式选项（默认 key 只绑一个项目） |
| audit log | Audit log | 审计日志 | 记录"谁在何时读了什么"；**只记元数据**，永不含 payload/检索原文 |
| fail-closed | — | — | 内部原则：审计写不进去 → 敏感读取直接拒绝。UI 对应一个专门错误态（见 §6.6） |
| purge | Purge | 清除 | 项目级一键删数据：事件/概念页/任务清空，**审计与身份保留**，显示删除计数 |
| webhook secret | Webhook secret | — | GitHub 验签密钥；UI 只显示"已配置/未配置"状态，永不回显值 |

---

## 6. 标准文案对照表（按组件类型，EN 为主稿）

### 6.1 高频按钮/动作

| 场景 | EN | ZH |
|---|---|---|
| 登录 | Sign in with GitHub | 使用 GitHub 登录 |
| 邀请 | Invite member | 邀请成员 |
| 铸 key | Mint API key | 铸造 API key |
| 吊销 | Revoke | 吊销 |
| 轮换 | Rotate key | 轮换 key |
| 复制命令 | Copy command | 复制命令 |
| 复制路径 | Copy path | 复制路径 |
| 加载更多（游标分页） | Load more | 加载更多 |
| 测试连接 | Test connection | 测试连接 |
| 清除项目 | Purge project data | 清除项目数据 |

### 6.2 空态（每个列表页一条；语气=诚实+指路，禁止装样子）

| 页面 | EN 建议稿 |
|---|---|
| 知识库（新团队） | **No knowledge yet.** Pages appear here once events are compiled. Connect GitHub, run `teamem init`, or hook up your agent via MCP. |
| 检索无结果 | No pages match your search. Try different words — semantic search understands paraphrases. |
| 事件列表 | No events ingested yet. Events arrive from GitHub, `teamem init`, or agent writes. |
| 任务列表 | No compile jobs yet. Jobs appear when events are queued for compilation. |
| 成员列表 | It's just you so far. Invite a teammate to share what your team knows. |
| API keys | No keys minted yet. Mint one to connect an agent or run `teamem init`. |
| 审计 | No audit records in this range. |

### 6.3 警告与确认（危险操作）

| 场景 | EN 建议稿 |
|---|---|
| key 明文一次性 | **Copy it now — you won't see this key again.** We store only a hash. |
| 吊销确认 | Revoke this key? Requests using it will fail **immediately** with 401. |
| 轮换警告 | Rotating mints a new key and revokes the old one **immediately**. Anything still using the old key will stop working. |
| purge 确认（输名弹窗） | This permanently deletes all events, pages and jobs in **{project}**. Audit records are kept. Type the project name to confirm. |
| purge 成功 | Purged: {n} events, {n} pages, {n} jobs removed. Audit trail retained. |
| 删除团队 | This deletes the team **{team}** and everything in it, for all members. This cannot be undone. |

### 6.4 降级与能力状态（红线要求明示）

| 场景 | EN 建议稿 |
|---|---|
| 检索降级横幅 | ⚠ Keyword search only — semantic search is unavailable. Results won't match paraphrases or other languages. **[Why?]** |
| 设置页常驻状态（fts-only） | Semantic retrieval: **Unavailable.** Your LLM provider has no embedding API. Search runs in keyword (FTS) mode. |
| 设置页常驻状态（vector） | Semantic retrieval: **Active** (1536-dim vectors, cosine similarity). |
| 无 provider | Compilation is paused — no LLM provider configured. Events are stored but won't become pages until you add one. |

### 6.5 权限与 404

| 场景 | EN 建议稿 | 备注 |
|---|---|---|
| 统一 404 | **Not found.** This page doesn't exist, or the link is out of date. | **绝不出现** "no access/permission" 字样（红线：跨团队与不存在不可区分） |
| viewer 触碰 member+ 功能 | You need a higher role for this. Ask a team admin. | 这个**可以**说权限——它是站内功能门槛，不是资源探测 |
| 未受邀登录 | You're not in a team yet. Ask your admin for an invite link. | |

### 6.6 审计相关

| 场景 | EN 建议稿 |
|---|---|
| payload 读取提示 | Payload access is recorded in the audit log. |
| fail-closed 错误态 | Can't display payload right now — audit logging is unavailable. Reads are blocked until it recovers. |

### 6.7 时间显示

- 相对时间 + hover 绝对时间（UTC ISO）：`Last confirmed 3 days ago`；
- 时间线用 `occurred_at`，标签 **Occurred**；
- 不要用 "Last updated" 这个词组，任何地方都不要（见 §2.4）。

---

## 7. 文案红线（自查清单——每条都来自冻结契约/工程红线，不是风格建议）

| # | 红线 | ❌ 错误示范 | ✅ 正确示范 |
|---|---|---|---|
| R1 | `last_confirmed` 不是更新时间 | Updated 3 days ago | Last confirmed 3 days ago |
| R2 | 降级必须明示，禁止假装语义检索在工作 | （无提示地返回关键词结果） | ⚠ Keyword search only… 横幅 |
| R3 | 404 不区分"无权"与"不存在" | You don't have access to this page | Not found. |
| R4 | actor 未知就是未知 | 显示 "System" + 机器人头像 | Unknown + 中性占位 |
| R5 | `client_claimed` 不进贡献者 | 把 CLI 自称的作者画进 contributor 列表 | 贡献者只画 verified 身份 |
| R6 | disputed ≠ 低置信 | Low confidence 标在矛盾页上 | Conflicting evidence — disputed |
| R7 | key 明文只此一次 | 提供 "View key" 再看一次入口 | 只有铸造瞬间 + "won't see again" 警告 |
| R8 | 占位功能不得像已实现 | F5 简报入口做成可点击的正常菜单 | 带 "Soon" 标记 + 说明页 |
| R9 | 空态必须诚实 | 空库时填充示例知识卡片 | 诚实空态 + 接入 CTA |
| R10 | skip 不是失败 | Skipped 用红色/错误图标 | 中性灰 + 原因说明 |
| R11 | 证据链接用 permalink | 链接到 branch 上的文件 | commit SHA 锚定的 permalink |
| R12 | 审计不展示内容 | 审计行可展开看"读了什么内容" | 只有资源类型 + ID + 跳转 |
| R13 | 错误信息不含内部细节 | 展示 SQL/堆栈/prompt 片段 | 一两行脱敏错误 + request ID |
| R14 | duplicate 是中性事实 | Duplicate 用警告色 | 中性徽章 "Duplicate — original result returned" |

---

## 8. 语气指南（Tone of Voice）

**一句话**：像一个严谨的资深工程师同事——说实话、给出处、不吹嘘。

1. **诚实优先于体面**。系统做不到就直说做不到（降级、暂停、空库），用户是
   开发者，糊弄会立刻失去信任——信任是这个产品唯一的护城河；
2. **每个断言可回溯**。涉及知识内容的文案往证据引：不说 "AI figured out"，
   说 "compiled from 3 commits and a PR discussion"；
3. **不用营销腔**。产品界面内禁止 "supercharge / magic / revolutionary /
   AI-powered" 一类词；登录页可以讲卖点，但用事实句式（"Every answer links
   back to the commit and discussion it came from"）；
4. **技术词不注水**。目标用户认识 MCP、webhook、API key、permalink——不要
   解释性地写成 "智能连接密钥"；该用术语就用术语；
5. **动词准确**。compile（编译）/ ingest（摄取）/ mint（铸造）/ revoke（吊销）
   / purge（清除）是产品既定动词，同一动作全站同一动词，不搞同义替换；
6. **警告分两档**。不可逆操作（purge、删团队、吊销）用严肃完整句 + 明确后果；
   一般提示保持一行以内。狼来了式的到处警告会稀释真正的危险操作；
7. **空态是导游不是道歉**。空态文案的任务是指出下一步动作，不是抱歉没有数据。

---

## 附：设计稿 mock 数据速配包

设计稿里直接可用的真实感示例（符合全部枚举/格式约束）：

- 概念页标题：
  - *Decision*: "Use RS256 with key rotation for service JWTs"
  - *Gotcha*: "pgvector HNSW index needs ANALYZE after bulk upsert"
  - *Convention*: "All queue messages carry teamId + projectId"
  - *Runbook*: "Rotating the GitHub webhook secret without downtime"
- path 示例：`backend/auth/jwt-rotation` · `infra/postgres/pgvector-tuning`
- key ID：`key_7f3a…`（可显示）；token：`tm_••••••••`（铸造页外一律打码）
- 检索 query 示例："why don't we retry failed webhooks?"（体现自然语言检索）
- 事件摘要示例："PR #214 merged — feat(auth): rotate signing keys (DUA-167)"
