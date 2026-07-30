# teamem portal — M2 Web UI 设计说明文档

> 设计稿为纯静态 HTML（打开 `index.html` 可总览全部页面）。
> 每个页面顶部有一条 **PREVIEW 工具条**（黑黄斜纹），用于切换该页面的各种状态
> （空态 / 错误态 / 降级态 / 弹窗态等）和 **Light / Dark 主题**——它不是产品 UI 的一部分。
> 数据全部取自 `UI-SAMPLES.md` 的 M1 验收库真实导出（48 个真实概念页、真实事件分布、
> 真实审计动作），文案遵循 `UI-GLOSSARY.md` 的标准对照表与文案红线。

---

## 0. 设计系统总览

**风格定位**：简单清晰的开发者工具（shadcn/ui 美学：中性灰底 + 单一品牌色 + 细边框卡片）。
不炫技、不装饰，信息层级靠字号 / 字重 / 间距表达，颜色只承担语义。

| 决策 | 定稿 | 理由 |
|---|---|---|
| 布局 | 左侧固定导航 252px + 顶部栏（团队/项目切换器 · 搜索 · 用户）+ 内容区 max-width 1180px | 对应 BRIEF §3 信息架构；开发者桌面工具惯例 |
| 主色 | Indigo `#4f46e5`（dark: `#818cf8`），主按钮用墨黑（dark 反白） | 单色accent，避免与六类型徽章争色；黑白主按钮是 GitHub/Vercel 式开发者工具惯例 |
| 中性色 | Zinc 系（bg `#fafafa` / surface `#fff` / border `#e4e4e7`） | shadcn 默认 neutral 轴 |
| 字体 | Inter（UI）+ JetBrains Mono（path / ID / 命令 / 数字 ID） | 开发者工具标配；等宽字体区分"机器标识符"与"人读文本" |
| 主题 | Light / Dark 双主题，全部走 CSS 变量 token | BRIEF Q3 建议默认：token 层双主题 |
| 圆角/间距 | 6/8/12px 圆角；4/8 间距栅格 | — |

### 徽章系统（全产品最高频视觉词汇，一次定稿三处复用）

**六类型徽章（type）** = 图标 + 彩色底胶囊：

| 类型 | 色 | 图标 | 语感 |
|---|---|---|---|
| `decision` | 紫 violet | git-branch（分叉=抉择） | 正式、结构性 |
| `gotcha` | 琥珀 amber | alert-triangle | 警示但非错误 |
| `convention` | 天蓝 sky | scroll | 规约、文本感 |
| `runbook` | 翠绿 emerald | list-checks | 可操作、步骤 |
| `service` | 石灰 slate | server | 基础设施、中性 |
| `concept` | 玫红 rose | lightbulb | 想法、定义 |

**四状态徽章（status）** = 弱一级的"圆点+文字"（与类型徽章视觉语言不同，避免双色块并排的嘈杂）：
`active` 绿点灰字（最弱）· `superseded` 灰点灰字 · `needs-review` 蓝点蓝字 ·
**`disputed` 琥珀底+三角图标（唯一升格的警示态，正文提示"conflicting evidence"，绝不写 low confidence——红线 R6）**

**三档置信度** = 三格小条（high 绿 3 格 / medium 琥珀 2 格 / low 红 1 格），弱视觉，不作为警告。

**其他徽章**：任务状态 5 态（queued 灰 / processing 蓝带脉冲点 / completed 绿 / failed 红 / cancelled 灰）、
逐事件结果 4 态（compiled 绿链页面 / **skipped 中性灰+真实枚举原因**（R10：不是失败）/ failed 红 /
**pending 虚线灰（"还没轮到"）**）、角色徽章（owner 紫 / admin 蓝 / member 绿 / viewer 灰框）。

### 全局组件（对应 BRIEF §5，一次设计到位）

诚实空态（图标+一句话+指路 CTA，禁止假数据）· 降级横幅（⚠ Keyword search only）·
一次性明文 key 展示（深色块+黄色等宽 token+"won't see again" 警告）· 可复制命令块（黑底+复制钮+一行用途说明）·
证据条目（图标+类型+permalink+时间，hover 提升）· 统一 404（中性文案，不区分无权/不存在）·
权限拒绝引导 · 审计提示条 · 骨架屏（`prefers-reduced-motion` 下停动画）·
危险确认弹窗（purge 输名确认 / 吊销普通确认 两档）· 团队/项目切换器 ·
三个时间概念的文案区分（**Last confirmed** ≠ created ≠ occurred，全站禁用 "updated"——红线 R1）。

### 图标

全部内联 SVG（Lucide 风格，24 viewBox、stroke 2、圆角线帽），不用 emoji（红线）。
GitHub 品牌 mark 用官方 octocat 路径。产品 logo 为工作用提案：圆角方块内三条递变横线
（"知识被逐层编译"的隐喻），全小写 `teamem` 字标。

---

## 页面清单（完成后逐页在此追加说明）

- [x] `index.html` — 设计稿总览 + 徽章/组件陈列
- [x] `login.html` — A1 登录
- [x] `invite.html` — A2 邀请接受
- [x] `onboarding.html` — B 首次引导向导（5 步）
- [x] `knowledge.html` — C1 概念页列表（默认落地页）
- [x] `concept-detail.html` — C2 概念页详情（产品价值落点）
- [x] `context-preview.html` — C3 上下文预览
- [x] `events.html` — D1 事件列表
- [x] `event-detail.html` — D2 事件详情（payload + 审计）
- [x] `jobs.html` — D3 编译任务列表
- [x] `job-detail.html` — D4 任务详情（逐事件结果）
- [x] `members.html` — E1 成员与角色
- [x] `member-profile.html` — E2 成员资料页
- [x] `settings-keys.html` — F1 API keys
- [x] `settings-sources.html` — F2 摄取源
- [x] `settings-llm.html` — F3 LLM 与检索
- [x] `settings-project.html` — F4 项目设置（含 purge）
- [x] `settings-team.html` — F5 团队设置
- [x] `audit.html` — F6 审计日志
- [x] `404.html` — 统一 404
- [x] `soon.html` — G P2 占位页（团队简报）
---

## 1. `login.html` — A1 登录页（P0）

**目的**：唯一身份入口；评估者看到的第一屏，承担一句核心卖点。

**布局决策**：居中窄卡（400px）而非分屏——"简单清晰"优先；logo + 产品名（全小写）+
一句事实句式卖点（"Every page links back to the commits, PRs and discussions it came from"，
不用营销腔）+ 唯一主按钮 + 三条事实卖点（Compiled, not written / Every claim has evidence /
Self-hosted），把"编译而非手写"的差异化在第一屏就讲出去。

**状态设计（PREVIEW 可切）**：
| 状态 | 设计 |
|---|---|
| 默认 | 主按钮墨黑带 GitHub 官方 mark |
| OAuth 失败 | 按钮上方 error banner（role=alert），可重试，不跳转 |
| 未受邀用户 | 整卡替换为引导页：显示已登录身份、明确"还不在任何团队"、指路邀请链接（**不是裸报错**）；附"退出换账号"次按钮 |
| App 未配置 | 按钮 **disabled** + 警告条说明 operator 需先建 GitHub App 写入 `.env`（README 前置步骤）；脚注强调"登录与摄取是同一个 App"，呼应 2026-07-29 拍板 |

**红线落实**：未配置态不让按钮"点了没反应"（BRIEF A1 明确要求）；未受邀不是错误页。
## 2. `invite.html` — A2 邀请接受页（P0）

**目的**：受邀成员经邀请链接加入团队。

**布局决策**：与登录页同族的居中卡（保持进入流程的视觉连续性），但把"你将加入什么"
做成三行事实卡（Team / Your role+一句话角色能力说明 / Invited by 头像），先回答
"这是哪、我能干嘛、谁邀的我"再给出动作按钮。角色徽章直接复用全局 role 组件。

**状态设计**：
| 状态 | 设计 |
|---|---|
| 未登录访客 | `Sign in with GitHub to join`（OAuth 后加入） |
| 已登录用户 | 摘要卡第三行变为"Joining as dli"，主按钮变为 `Join team`（跳过 OAuth），附"Not you? Switch account"ghost 按钮 |
| 链接失效 | 明确失效态（时钟图标空态），说明两种可能（过期/已用）+ 指路"要新链接"，**不指责用户**；给出回到登录页的出口 |

**红线落实**：有效期 7 天、单次使用（BRIEF Q7 默认）写在脚注，透明可预期。
## 3. `onboarding.html` — B 首次引导向导（P0，M2 的灵魂）

**目的**：让陌生人 30 分钟内从 `docker compose up` 走到"agent 问出第一个带引用的回答"，
浏览器侧零终端。设计目标：每一步"下一步干嘛"毫无歧义。

**布局决策**：脱离主应用外壳的**专注流**——顶部仅 logo + 5 步进度条 + Exit setup，
内容单列窄卡（640px）居中。进度条三态（done 绿勾 / now 描边高亮 / 未到灰），
可中途退出续做。PREVIEW 可逐步切换，含两个关键变体（fts 降级、等待中）。

**逐步设计**：
| Step | 关键决策 |
|---|---|
| 1 团队 | 两字段+默认值+一句"project=一个代码库边界"的作用域解释；告知首个用户将成为 owner |
| 2 LLM | provider 做成**可选中卡片**（radio card）而非下拉——四家对比信息（有无 embedding）直接印在卡片上，把降级红线的教育前置到选择时刻；"Test connection"即时反馈；**能力提示条**紧随配置卡：vector=绿 success / fts=琥珀 warn 并说明影响（paraphrase/跨语言不命中）与可改路径；跳过按钮写明后果"compilation stays paused" |
| 3 仓库 | 文案刻意写"same app / no new connection, just repository scope"，消除"是不是重新连一次"的困惑；主动作是跳 GitHub 管理 installation；仓库列表只读回显；webhook secret 只显示状态不回显值；可跳过（CLI/MCP 也能供数据） |
| 4 key | **一次性明文组件**：深色 keyreveal 块 + 黄色等宽 token + "won't see this key again" 警告（红线 R7）；三段命令各配一行"这条命令做什么"（接 agent / 扫存量 / 装 hook 自动注入）；Continue 按钮文案"I've copied the key"形成确认动作 |
| 5 完成 | 实时三指标（Events/Jobs/Pages，数字 tabular）；产出第一页就地展示可点击卡片 → 直达详情；**等待态**是诚实空态：计数为 0 + 三条排查指引（对应"init 没跑 / App 没装到仓库 / 有事件但没 provider"三种真实卡点） |

**红线落实**：降级明示（R2）在 Step 2 就是一等公民；key 只现一次（R7）；空态指路不道歉（GLOSSARY §8-7）。
## 4. `knowledge.html` — C1 概念页列表（P0，登录后默认落地页）

**目的**：浏览 + 语义检索团队知识库。本页同时定稿**全局应用外壳**（侧边导航 + 顶部栏），
后续所有已登录页面复用。

**外壳决策**：
- 侧边栏按 BRIEF IA 分四组（Knowledge / Activity / Team / Settings），`Team digest` 带 SOON 徽章占位；底部版本号+"self-hosted"强化信任叙事；
- 顶部栏 = 团队切换器 / 项目切换器（两级作用域一眼可见）+ ⌘K 搜索入口 + 用户头像；
- 内容区 max-width 1180px，桌面优先。

**列表行设计**（真实契约字段全部落位）：
- 行 = `[类型徽章] 标题 [状态徽章(非 active 才显示)]` + 第二行 `path(等宽) · N evidence · Last confirmed …`；右侧 = 置信度三格条 + 贡献者头像组；
- **active 状态不显示徽章**（最弱视觉），disputed 升格为琥珀警示徽章——行列即体现"矛盾但高置信"的真实组合（pg-boss 决策页）；
- **贡献者大多数行为空**（真实 48 页仅 5 页有），有贡献者时区分：人类=圆形彩色头像（可点）、service 主体=圆角方形 bot 图标头像（不可点，hover "Service account"）——对应 Q9；
- 标题最长 84 字符（真实数据）：标题区允许两行自然换行，不截断；
- 分页 = 底部居中 `Load more`（游标式，无页码）。

**检索态的三条真实约束落实**（UI-SAMPLES §3.5）：
1. **不显示 relevance 原始数值**——只显示结果计数 + "Top match first" 提示（title 解释为什么：余弦相似度 0.36 也是正确命中）；
2. **结果行无正文预览**——契约只回摘要字段，行组件与列表态完全一致；
3. **降级横幅（整次 degraded）**独立于行级 ftsFallback：横幅为琥珀 warn + "Why?" 链接到设置页。

**其他状态**：
- **viewer 视角**：检索框整块消失，换成 info 横幅说明"检索需要更高权限"+ Request access 按钮（权限拒绝态的引导范式）；列表仍可浏览进详情（Q1 默认）；
- **空库**：诚实空态 + 三条接入路径 CTA（连 GitHub / 跑 init / 接 MCP），与引导 Step 5 排查指引呼应；
- **无结果**：文案强调"换说法也能命中"教育语义检索；**绝不出现"可能没权限"暗示**（§3.4：跨团队探测=空结果）；
- **骨架**：行级 skeleton，`prefers-reduced-motion` 下停动画。

**PREVIEW 状态**：列表 / 检索结果 / 降级横幅 / 无结果 / 空库 / viewer / 骨架（7 态）。
## 5. `concept-detail.html` — C2 概念页详情（P0，"为什么"时刻的最终画面）

**目的**：完整呈现一条知识及其可信度来源。整个产品价值的落点。

**布局决策**：页头（徽章行→大标题→path/时间/UUID 可复制 meta 行→tags）+
**双栏网格**：左主栏正文卡片（长文排版，六小节，max 可读宽度），右栏 330px sticky 三卡
（Evidence → Contributors → Timeline）。证据卡放在右栏**最上方**而非正文下方——
它是"这条知识可信"的第一证明，滚动时始终可见（sticky）。桌面优先；窄屏自动单列。

**关键设计**：
- **证据组件按 kind 分支渲染**（真实数据三种字段形状）：`pr`/`commit` 只有 ref（显示
  repo/pull/107、repo@sha 短形式 + "permalink" 标注）；`repo_file` 无 ref，渲染
  repo@sha · 路径三元组 + "commit-pinned" 标注；`mcp_write` 无外链，转为**站内事件
  详情链接**并附说明。时间文案区分语义：外部证据="Occurred"（源头时间），
  repo_file="Snapshot"（摄取时间）——落实 SAMPLES §2.1 约束；
- **三个时间戳同时出现且互不相同**（firstSeen/createdAt/lastConfirmed），meta 行只露
  Last confirmed + Created，hover 给 UTC 绝对时间；全站无 "updated" 字样（R1）；
- **贡献者三种形态**：绑定账号（本例无）/ 纯 GitHub（外链+“not a portal member yet”）/
  **service 主体（bot 图标方角头像、不可点、标注 Service account）**；空态文案解释
  "self-reported identities don't appear here"（R5）；
- **正文内链**：`teamem://concept/<uuid>` 渲染为虚线下划线的站内跳转（与外链视觉区分），
  hover 显示原始 URI；M2 无编辑能力，页面没有任何编辑入口；
- **disputed 变体**：顶部警示条写 "Conflicting evidence"（绝不写 low confidence，R6），
  明确"confidence 保持 High"；正文如实呈现 Position 1/2 两小节，并附一行说明"编译器
  不把证据映射到立场"——P2 矛盾对账入口为 disabled 按钮 + SOON 徽章，**不像已实现**（R8）；
- **时间线**：按 occurred_at 降序，accent 点标记最新；GitHub 事件带验签 ✓ 标，
  cli/mcp 事件灰点；时间间隔可跨越数月，不做均匀刻度假设。

**PREVIEW 状态**：决策页(3类证据) / disputed / mcp 证据+空贡献者 / 骨架。
## 6. `context-preview.html` — C3 上下文预览（P0）

**目的**：预览 SessionStart 注入端点给 agent 塞什么——"你的 agent 每次开新会话会自动知道这些"。

**布局决策**：窄栏（860px）聚焦阅读。页头一句话点明机制（`GET /v1/context`），
主体一张"Injected summary"卡：每行 = 类型徽章 + 标题（链详情）+ 一行摘要 + path，
内容用 SAMPLES §4.3 的真实 spot-check 五页。
**token 预算指示**放在卡片头右侧：细进度条 + `~450 / 800 tokens`（等宽数字），
预算占用用绿色——这是"受控注入"的信任信号，不是警告。
第二张卡承接引导：未装 hook 的用户给出 `teamem cli install-hook` 命令块（复用全局命令组件）。

**状态**：默认 / 空库（诚实空态 + "Feed the compiler" 指向摄取源页）。
member+ 能力；viewer 导航里本项隐藏，不设计 viewer 变体。
## 7. `events.html` — D1 事件列表（P1）

**目的**：回答"我的数据进来了吗"——引导期与排障时的第一落点。

**设计决策**：
- 四列表格：Source（图标 pill，六种来源各一图标）/ Actor / Summary / Occurred（相对时间+hover UTC）；
- **Unknown 是默认态**：10 行里 7 行 actor 为 Unknown（真实比例 78/82）——虚线灰头像+"Unknown"灰字，
  绝不编造"System"头像（R4）；只有 GitHub 行带绿色验签 ✓（hover 解释
  "Identity verified by GitHub webhook signature"），呼应契约"只有验签 connector 能背书身份"；
- **cli_init 摘要中间截断**：`ec316e3a…:docs/…/roll-back-a-deployment.md`（等宽），
  保留最有信息量的 commit 前缀与文件名（SAMPLES §5.3）；
- 筛选 chip 按来源（GitHub 折叠为一组/CLI/MCP），计数 82 与真实库一致；游标分页 Load more；
- 空态文案直抄 GLOSSARY §6.2，CTA 指摄取源页。

viewer 可看列表不可进详情（行仍渲染但不带跳转——实现时按角色去除链接；mock 默认 member 视角）。
## 8. `event-detail.html` — D2 事件详情（P1）

**目的**：查看单条事件的元信息与脱敏 payload（member+，读取被审计）。

**设计决策**：
- 窄栏两段式：**元信息卡**（来源 pill + kv 表：Event ID 可复制 / Actor+验签标 / Occurred（标注 source time 与 Received 区分）/ External ID 等宽全量）→ **审计提示条**（info 蓝，常驻 payload 区上方，GLOSSARY §6.6 原文）→ **payload 卡**（JSON 语法着色查看器，标题注明 "redacted at ingest"）；
- **fail-closed 态**（红线，不是普通报错）：payload 卡整个替换为锁定空态——锁图标 +
  "Audit logging is unavailable, and payload reads are blocked until it recovers.
  This is intentional"，Retry 按钮 + Request ID；刻意解释"这是设计如此"，
  把产品原则讲给用户而不是丢一个 500；
- 脱敏认知（SAMPLES §8）：UI 里没有"被打码的内容"可展示，所以 payload 查看器**不做**
  任何"此处有隐藏段"的标记——私有段在落库前已整段移除。

**PREVIEW 状态**：payload 可读 / fail-closed。
## 9. `jobs.html` — D3 编译任务列表（P1）

**目的**：摄取与编译的可观测性——"事件没变成知识时，答案在这里"。

**设计决策**：
- 六列表格：Kind（等宽，真实三值 `ingest_event` / `ingest_batch` / `compilation`）/
  Status 五态徽章（queued 灰 · processing 蓝+脉冲点 · completed 绿 · failed 红 · cancelled 灰，
  processing 脉冲在 reduced-motion 下静止）/ Events 数（右对齐 tabular）/
  Initiated by（`teamem init` 等宽、GitHub webhook、MCP write）/ Created 相对时间 / Duration；
- 首行即真实失败样例（`no_llm_provider`，2.3s 快速失败）——排障入口置顶可见；
- 筛选 chip 按五态；副标题直接把页面定位讲清（排障导向）。

**PREVIEW 状态**：默认 / 空态。
## 10. `job-detail.html` — D4 任务详情（P1）

**目的**：逐事件看一次编译任务的结局——排障的最终落点。

**设计决策**：
- 上卡元信息（kind + 状态徽章 + UUID 复制 + 事件计数按结局着色分解，如
  `4 — 2 compiled · 1 skipped · 1 pending`），下卡逐事件结果列表；
- **四态结果组件**（契约 `jobEventResult` 四分支，含 BRIEF 曾遗漏的 `pending`）：
  `compiled` 绿勾 + → 链接到产出页（带类型徽章）；`skipped` 中性灰 + 真实枚举
  `no_knowledge` + 一行解释"healthy filtering, not a failure"（R10：skipped 占 12%，
  不是错误）；`pending` 虚线灰 + "In queue"；`failed` 红叉 + 稳定 code；
- **失败任务变体**：错误卡以**正文排版**渲染真实 message（它本身就是可执行的排查
  指引——列出四个环境变量），不折叠成小字；附"Go to LLM settings"行动按钮 +
  "事件已安全存储可重编"的安抚说明（SAMPLES §4.2 的真实场景）。

**PREVIEW 状态**：处理中(三态同框) / 失败任务(no_llm_provider)。
## 11. `members.html` — E1 成员与角色（P0）

**目的**：团队的登录成员管理（邀请 / 改角色 / 移除）。

**设计决策**：
- 表格：Member（头像+login+GitHub 主页，自己带 "You" 标）/ Role（徽章；owner 视角为可点
  下拉 chip）/ Joined / Remove（红色 ghost，视觉分离）；页脚一行说明"仅 owner 可改角色/
  移除，最后一名 owner 不可被降级"；
- **邀请弹窗**：角色做成**带能力描述的 radio 卡**（直抄 GLOSSARY §3.1 的一句话定义），
  Member 默认选中——邀请时就把权限讲清楚，避免乱给 admin；
- **链接生成弹窗**：复用命令块展示链接 + info 条写明"7 天有效 · 单次使用 · 可吊销"（Q7 安全默认）；
- 空态直抄 GLOSSARY §6.2："It's just you so far." + 主 CTA。

**PREVIEW 状态**：列表 / 邀请弹窗 / 链接已生成 / 单人空态。
## 12. `member-profile.html` — E2 成员资料页（P1）

**目的**：C2 贡献者链接的落点（M2 验收点名"贡献者链接指向真实成员资料，不是占位符"）。

**设计决策**：
- 资料卡：大头像 + login + GitHub 外链按钮（octocat+外链图标）+ 角色徽章 + 加入时间；
- "Contributed pages" 完整复用 C1 的 `.krow` 行组件（类型徽章/path/证据数/置信度），
  页面脚部一行小字再次解释归因规则："Only webhook-verified contributions appear here"
  ——因为用户从概念页点进来时最可能的疑惑就是"TA 明明写过代码，怎么只有两页"。
## 13. `settings-keys.html` — F1 API keys（P0）

**目的**：铸造 / 吊销 / 轮换接入凭证。本页定稿**设置区 tabs 范式**（API keys · Ingestion ·
LLM & retrieval · Project · Team）。

**设计决策**：
- 表格七列：Name / Key ID（`key_…` 可复制，页脚明确"ID 不是密钥"）/ Scopes（等宽 tag）/
  Project（单项目或 All projects）/ Created / Status / Actions（Rotate+Revoke 收敛在行尾 ghost 按钮）；
  已吊销行整行降透明 + 名字删除线 + 无操作；
- **铸造弹窗**：名称 / 项目下拉+All projects 勾选（团队级 key 是显式选项）/ scope 复选框
  每项带一句解释（`read:payload` 标注"audited"）；底部常驻"keys never carry admin rights"；
- **一次性明文弹窗**：与引导 Step 4 同一组件（keyreveal 深色块 + 黄色等宽 token +
  "won't see this key again" 警告 + 附 `claude mcp add` 可粘贴命令），完成按钮文案
  "Done — I've saved the key"形成确认动作（R7）；
- **吊销确认**：普通确认档（非输名档）但文案明确"立即 401"；列出将吊销 key 的完整身份信息
  （ID/项目/scope/创建时间）防止误操作；role=alertdialog；
- 轮换警告在 Rotate 按钮 tooltip + 文档说明（M1 实测曾因此把在用的 key 弄失效——警告不能省）。

**PREVIEW 状态**：列表 / 铸造弹窗 / 一次性明文 / 吊销确认 / 空态。
## 14. `settings-sources.html` — F2 摄取源（P0）

**目的**：三条摄取路径的状态与接入指引（GitHub App / CLI / MCP）。

**设计决策**：
- **GitHub App 大卡**：状态徽章 + kv（App 名 / 安装到的 org / 仓库 tag 组 / webhook secret
  只显状态不显值 + Regenerate 的代价提示）+ "Manage on GitHub" 跳转；**Recent deliveries**
  列表含一条真实的失败投递（signature mismatch, rejected——验签拒绝也是健康行为，
  用红色 ✗ 但文案讲清原因）；副标题再次强调"与登录同一个 App"（2026-07-29 拍板）；
- **CLI 卡**：不是"连接"是指引——key 选择器（联动 F1，只读 key 标注 "can't ingest" 防止
  选错）+ 完整命令块（token 处占位 `<paste-key>`，因为这里不是铸造瞬间，绝不回显明文）+
  最近一次 init 的时间/规模（3 events → 2 pages，真实输出格式）；
- **MCP 卡**：`claude mcp add` 命令 + 端点健康状态 + 一句"agent 的 MCP 调用在审计里与
  Web 活动分开记"（SAMPLES §6 的真实动作拆分）。

**PREVIEW 状态**：默认。
## 15. `settings-llm.html` — F3 LLM 与检索（P0）

**目的**：provider 配置（引导 Step 2 的完整版）+ 语义能力常驻状态 + 编译节奏占位。

**设计决策**：
- provider 卡与引导同一组件（四张 radio 卡，"有无 embedding"印在卡上）；key 密文 +
  眼睛切换；Test connection 带延迟读数（214ms）让"测试成功"更可信；
- **语义能力是常驻状态卡而非一次性提示**（BRIEF 要求）：vector = 绿卡 + 一句降级承诺
  （"降级会自动发生且明示"）；fts-only = **卡片本身变琥珀描边** + 头部 amber pill
  "Unavailable — keyword (FTS) mode" + warn 横幅解释影响与改法——让"降级"在设置页
  一眼可见，与 C1 检索框旁的横幅互为镜像（R2）；
- 编译节奏：选项未定的诚实占位卡（"Event-driven"现状 + 一句"选项设计中"），不做成
  有控件但不可用的假设置（R8）。

**PREVIEW 状态**：vector / fts-only。
## 16. `settings-project.html` — F4 项目设置（P0）

**目的**：项目基本信息 + 失效检测占位 + 危险区 purge。

**设计决策**：
- General 卡：项目名 + 项目 ID（`prj_…` 可复制，hint 说明用途）；
- **Staleness detection（P2 占位）**：disabled 开关 + SOON 徽章 + 一句话讲产品方向
  （"引用的代码变了→知识可能过期"）——开关呈现 disabled 而非可点假控件（R8）；
- **Danger zone**：红描边卡 + 红标题，purge 按钮用 danger-outline（与主操作视觉隔离）；
  owner-only 标注在描述里；
- **purge 确认弹窗（输名档）**：error 横幅说清删什么留什么 + 输入项目名才能确认
  （危险操作最高档，GLOSSARY §6.3 原文）；
- **purge 成功页**：绿色空态 + **删除计数**（82 events / 48 pages / 31 jobs——契约要求记录
  数量）+ "审计与身份保留，且本次 purge 本身已留痕" + 直达审计页的链接（M2 验收点）。

**PREVIEW 状态**：默认 / purge 确认 / purge 成功。
## 17. `settings-team.html` — F5 团队设置（P0）

**目的**：团队名、多团队管理、删除团队。

**设计决策**：
- "Teams on this portal" pill 组直观呈现多团队（当前团队 accent 描边+勾），新建入口同排；
  hint 强调"多团队数据完全隔离，顶部栏切换"——这是 M2 真实能力，不是装饰；
- 删除团队走**输名档确认**（与 purge 同级）；弹窗中删除按钮在输入匹配前 disabled 展示，
  让"输名解锁"机制可见；文案用 GLOSSARY §6.3 原文（"for all members" 点明影响面）。
## 18. `audit.html` — F6 审计日志（P0，admin+）

**目的**：M2 验收原文——"可查『谁在什么时候读了哪条知识』，支持按 actor/时间筛选"。

**设计决策**：
- 六列：Time（相对+hover UTC）/ Actor（人=头像、API key=key 图标、service=bot 图标，
  三类主体一眼可辨）/ Action（等宽六个真实动作值 + purge 留痕行）/ Resource（类型+ID+
  链到资源页）/ Outcome（success 绿字 / **denied 红 pill——被拒也留痕**）/ Request ID
  （短显+可复制，排障锚点）；
- **没有任何内容列**（R12 的物理落实）：副标题明写"Metadata only — query text and
  payloads are never stored here"，行不可展开；
- 筛选器右端常驻一行解码提示 "`mcp.*` = via agent · others = web UI"——把 SAMPLES §6
  发现的"agent 检索与 Web 检索分开记"变成可用的筛选维度（J4 治理日的真实问题
  "上周谁读过支付项目的 payload"可直接答）；
- 行内含一条 viewer 的 `search.query / denied`——正是"邀请 viewer 验证其被拒"的
  M2 验收场景在审计里的样子；purge 行带删除计数摘要。

**PREVIEW 状态**：默认 / 空态。
## 19. `404.html` — 统一 404（P0，红线 R3）

**目的**：跨团队探测与真不存在必须是同一个页面——所以只有一种 404。

**设计决策**：保留应用外壳（用户已登录，只是资源不在）+ 居中大空态：
"Not found. This page doesn't exist, or the link is out of date."——
**全文不含 "access / permission / 无权" 的任何暗示**（GLOSSARY §6.5 原文直抄），
唯一出口是回到 Knowledge 主按钮。与检索空态（§3.4：跨团队=空结果）共同构成
"探测面完全无信息"的设计闭环。

## 20. `soon.html` — G P2 占位页（P2）

**目的**：给评估者讲产品方向（团队周报），同时绝不像已实现（R8）。

**设计决策**（本页即"即将推出"统一视觉语言的定稿）：
- 页面正中大号 `COMING IN V1.5` 徽章开场，一句话讲清这个故事（每周自动编译：
  新决策 / 咬过人的坑 / 需要人裁的矛盾）；
- **示例卡用"幽灵形态"**：虚线描边 + 类型徽章 + skeleton 占位条 + "example, not
  live data" 标注——让评估者看到形态，又绝不误读为真实数据；
- 底部 info 横幅再次明示"nothing on it is live"并给出回到真实功能的出口；
- 三处 P2 占位全部复用 `pill.soon`（虚线描边 accent 小方章）：导航项、本页、
  disputed 页的 Reconciliation 按钮、项目设置的 Staleness 开关。

---

## 附：交付物索引与工程说明

**文件**：20 个 HTML + `assets/main.css`（设计系统 token+组件，~550 行）+
`assets/mock.js`（预览工具条的状态/主题切换，非产品代码）+ `DESIGN.md`（本文）。

**与 shadcn/ui 的映射**（实现期）：`.btn`→Button、`.input/.select`→Input/Select、
`.card*`→Card、`.table*`→Table、`.tabs`→Tabs、`.modal*`→Dialog（alertdialog 用
AlertDialog）、`.tbadge/.sbadge/.pill`→Badge 定制变体、`.empty`→自定义 Empty 组件、
`.cmd`→自定义 Command 块（+lucide Copy icon）、`.banner`→Alert、骨架→Skeleton、
`.switch`→Switch。颜色全部对应 CSS 变量 token，可直接落成 Tailwind theme。

**最低支持宽度建议**：1024px（侧栏 252 + 内容 1180 内自适应）；<900px 时侧栏
折叠为顶部流式导航（已在 CSS 响应式段定义），移动端只保证"不崩坏的只读浏览"（BRIEF §9-7）。

**自检结论**（对照交付清单 §9）：
1. 信息架构：按 BRIEF §3 实现，无 Dashboard（Q2 默认）；
2. P0+P1 全页面线框+高保真同体（静态 HTML 即高保真），每页含空/错/降级/无权变体；
3. 8-10 屏门面页全覆盖（登录/引导 5 步/列表/详情/检索/key 铸造/审计）；
4. 组件清单与徽章系统见 §0 与 index.html 陈列区；
5. P2 占位统一视觉语言见 §20；
6. 桌面优先，1024px 建议宽度 + 移动端兜底响应式。
