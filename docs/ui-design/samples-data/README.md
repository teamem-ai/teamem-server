# UI 设计素材数据包 —— M1 验收库导出（2026-07-29）

这是 [UI-SAMPLES.md](../UI-SAMPLES.md) 里所有【A·逐字】数据的**原始导出**。
文档里为了可读性做了摘录和排版，这里是完整的机器可读版本。

## 来源与真实性

- 导出自 **2026-07-28 M1 最终验收**留下的数据库（真实 PostgreSQL + pgvector +
  真实 LLM provider(OpenRouter) + 真实编译管线）；
- **语料是合成的工程语料，无任何真实客户数据**；
- **但编译产物是真的** —— 每个标题、每次类型判定、每条 tag、每次 F2 合并
  都是真实 LLM 管线的真实输出，不是人写的 mock；
- 导出时库存量：`projects=28 concepts=48 evidence=61 events=82 jobs=31`。

## 文件清单

| 文件 | 内容 | 谁用 |
|---|---|---|
| `concepts.json` | **48 个概念页完整详情** —— 正文全文、tags、evidence、contributors、三个时间戳、aliases | 详情页(C2)、列表页(C1) |
| `concepts.csv` | 同上的扁平表，多一列 `body_chars` | 列表页密度设计、Excel 里排序筛选 |
| `evidence.csv` | 61 条证据逐行（含 `kind` 分支的不同字段形态） | 证据组件(C2-3) |
| `contributors.csv` | 7 条贡献者关联（含 `service` 主体） | 贡献者区块(C2-4)、成员资料(E2) |
| `activity-and-audit.json` | 事件来源分布 / actor 真实结构 / 任务状态 / 逐事件结果 / 真实 job 错误 / 审计动作词表与表结构 | 活动区(D1–D4)、审计页(F6) |
| `db-snapshot.sql` | **可恢复的库快照**（1.2MB） | **不在本目录** —— 见下方说明 |

> **`db-snapshot.sql` 不在本仓库。**为避免把 1.2MB dump 塞进产品仓库历史，它留在
> 规划库 `teamem-ai/plan` 的 `tasks/M2/ui-samples-data/db-snapshot.sql`。做静态实现
> 只用本目录这几个轻量文件即可；只有需要"起一个活数据库做可交互原型"时才需要它，
> 那时去规划库取。下方"恢复数据库"一节假设你已经拿到了那个文件。

## 直接可用的关键事实

不看文件也该知道的几条（详细说明见 UI-SAMPLES 对应章节）：

- **正文长度 223 – 3228 字符，中位数 917** —— 详情页必须按长文排版设计，
  不是一两句摘要；
- **48 页里只有 5 页有贡献者** —— 贡献者区块的空态是默认视图；
- **7 条贡献者里 5 条是 `service` 主体** —— 无头像、无 GitHub 主页可链，
  BRIEF/GLOSSARY 原本没有覆盖这种形态（见 BRIEF §10-Q9）；
- **82 条事件里 78 条 actor 为空** —— "有头像的行"不是默认态；
- **证据数 1–3 条**，最多的一页是 `decisions/use-postgresql-pgvector`（3 种 kind）；
- **path 只在项目内唯一** —— `decisions/api-rate-limiting` 在 3 个项目各有一份，
  跨项目视图必须用 UUID 做 key。

## 恢复数据库（做可交互原型时）

```bash
# 起一个 pgvector 容器
docker run -d --name teamem-samples -e POSTGRES_USER=teamem \
  -e POSTGRES_PASSWORD=<自选> -e POSTGRES_DB=teamem \
  -p 55440:5432 pgvector/pgvector:pg17

# 恢复
docker exec -i teamem-samples psql -U teamem -d teamem < db-snapshot.sql
```

**快照里不含 `api_keys` 表**（凭据表整表排除，连哈希也没有）。恢复后若要通过
API 访问，需要自己 bootstrap 一把新 key：

```bash
DATABASE_URL=postgres://teamem:<密码>@127.0.0.1:55440/teamem \
  pnpm --filter @teamem/server bootstrap -- \
  --team-name "<已有团队名>" --project-name "<已有项目名>" --rotate
```

（`pgboss` schema 也排除了 —— 队列状态对设计无用，且会让快照大一倍。）

## 局限与注意

1. **这是一台开发机上容器的快照，不是长期服务。**要长期保留就靠这个目录里的
   文件本身，别依赖那台机器还开着。
2. **`display_login` 里有一个真实 GitHub 账号 `dli`**（导出时的操作者，已公开
   于仓库 commit 记录），其余（`why-moment-demo`、`m1-semrecall-svc`、
   `why-demo-service`）都是验收时创建的合成账号。
3. **数据分布偏 CLI 摄取**（77/82 事件来自 `teamem init`），GitHub 与 MCP 来源
   各只有少量样本。设计 D1 的来源筛选器时，真实产品里的比例会随团队接入方式
   变化，不要把这个分布当成通用比例。
4. 快照里保留了 M1 修复前的**遗留数据**（如 `job_events.reason` 里有 5 条模型
   自由文本）。**API 不会返回它们** —— 读路由会归一化成契约枚举。设计以
   UI-SAMPLES §5.6 的说明为准，不要直接照抄库里的原始值。

## 重新导出

三份 CSV/JSON 都可以从 `concepts.json` 或数据库重新生成，命令见
[UI-SAMPLES.md](../UI-SAMPLES.md) 附录。
