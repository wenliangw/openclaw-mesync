# openclaw-mesync (ocms) 设计文档

> mesync 记忆引擎的 OpenClaw 插件。**决策 / 认知 / 品味**三概念 + **决策因果链**结构化记忆，面向 **Agent 本体**。

---

## 1. 定位

ocms 是 mesync「决策、认知、品味」三概念核心在 **OpenClaw 场景**下的插件实现。

```
mesync（核心概念：决策/认知/品味 + 因果链）
  ├── dsh-mesync        —— dsh（Cordis）场景插件，已验证可行性
  └── openclaw-mesync   —— OpenClaw 场景插件（本项目，简称 ocms）
```

ocms 相对 dsh-mesync 的两个跃迁：

1. **补上「决策向量检索」能力缺口** —— dsh-mesync 的决策检索只有关键词 LIKE 匹配，ocms 借 OpenClaw 的 embedding 能力补上向量检索。
2. **维度升层** —— dsh-mesync 面向「写代码」这一件事；ocms 面向 **Agent 本体**，三概念覆盖 Agent 能做的所有事（查资料、做判断、写代码、呈现、沟通……），不止写代码。

---

## 2. 核心设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 存储分层 | **决策进 SQLite，品味/认知进 Markdown**（方案 X） | 沿用 dsh-mesync 已验证的分层；只有决策需要结构化因果链 |
| 向量检索 | **只给决策表加 embedding** | 品味/认知的向量检索由 OpenClaw 原生 `memory_search` 白送，无需自己造 |
| embedding 来源 | **复用 OpenClaw 的 embedding provider** | 零重复配置，用户配一次 OpenClaw embedding，ocms 继承 |
| 检索时机 | **Active Memory + 自定义 recall 工具** | 主回复前阻塞检索，注入相关决策 |
| 更新时机 | **`agent_end` 钩子** | 任务结束后自动提取决策/认知/品味 |
| 开发身份 | **wenliangw（糖豆）全权** | 糖豆独揽项目，不走「小明开发 + 糖豆 review」双人流程 |

---

## 3. 存储架构

### 3.1 决策（Decisions）→ SQLite

决策是「枢纽」，连接认知与品味，以**因果链**串联。这是唯一进 SQLite 的概念，因为因果链必须结构化存储（不能靠模型临场推理，会漂移）。

```sql
CREATE TABLE IF NOT EXISTS decisions (
  id            TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL,
  session_id    TEXT,
  decision      TEXT NOT NULL,      -- 决策内容
  trigger       TEXT,               -- 触发情境
  rationale     TEXT NOT NULL,      -- 为什么这么定
  evidence      TEXT,               -- 依据
  outcome       TEXT NOT NULL DEFAULT 'adopted',  -- adopted/reverted/refined/pending
  caused_by     TEXT,               -- 因果链：上游决策 id
  supersedes    TEXT,               -- 因果链：被替代的旧决策 id
  alternatives  TEXT NOT NULL DEFAULT '[]',  -- JSON [{option, why_not}]
  taste_signals TEXT NOT NULL DEFAULT '[]',  -- JSON [{signal, context}] 关联品味
  scopes        TEXT NOT NULL DEFAULT '[]',  -- JSON [分类路径] 软分类
  embedding     BLOB                 -- ← ocms 新增：决策向量（浮点数组）
);

CREATE INDEX IF NOT EXISTS idx_decisions_created ON decisions(created_at);
CREATE INDEX IF NOT EXISTS idx_decisions_caused_by ON decisions(caused_by);
CREATE INDEX IF NOT EXISTS idx_decisions_outcome ON decisions(outcome);
```

> **相对 dsh-mesync 的增量**：仅新增 `embedding` 列，其余字段完全沿用已验证结构。

### 3.2 认知（Cognition）→ Markdown

认知 = Agent「世界是怎么运作的」知识/方法论。自由文本，用 Markdown 更自然，由主 agent 惰性生成/维护。

- 存储：`.ocms/cognition/` 下的 Markdown（升维后不叫 wiki，叫 cognition）
- 检索：OpenClaw 原生 `memory_search`（向量）或直接 read

### 3.3 品味（Taste）→ Markdown

品味 = 用户/Agent 的审美、偏好、判断倾向。同样是自由文本。

- 存储：`.ocms/taste/` 下的 Markdown
- 检索：OpenClaw 原生 `memory_search` 或直接 read

---

## 4. 三概念的升维语义

| 维度 | dsh-mesync（写代码） | ocms（Agent 本体） |
|------|---------------------|-------------------|
| 决策 | 代码实现方案取舍 | Agent 做任何事时的行动决策（怎么查、怎么做、怎么取舍） |
| 认知 | 代码/架构知识 | 世界运作的知识、跨任务的方法论 |
| 品味 | 代码风格偏好 | 广义的审美/判断倾向（怎么说话、怎么呈现、怎么判断好坏） |

---

## 5. 运行链路

```
OpenClaw 主回复流程
  ↓
[Active Memory 阻塞子 agent]     ← 回复前
  └─ 调 ocms_recall 工具         ← 向量检索相关决策
  └─ 命中 → 注入隐藏前缀
  ↓
[before_prompt_build hook]        ← （可选）注入认知/品味 Markdown 内容
  ↓
主模型回复
  ↓
[agent_end hook]                  ← 回复后，fire-and-forget
  └─ 提取本轮新决策/认知/品味
  └─ 写入门控（溯源 + 冲突检测 + 置信度）
  └─ 决策写入 SQLite（含 embedding）
```

### 5.1 回复前（注入）

- **决策**：Active Memory 调 `ocms_recall`，向量检索 + 因果链过滤（优先「当前生效」的决策）
- **认知/品味**：`before_prompt_build` hook 注入 Markdown 速览（或让 Active Memory 走 OpenClaw 原生 `memory_search`）

### 5.2 回复后（更新）

`agent_end` hook 触发提取逻辑：
- **门控**（继承此前外部审查的教训——「写入无门控、无溯源」是核心批评）：
  - 溯源：记录来源 session/turn
  - 冲突检测：新认知是否与旧认知矛盾
  - 置信度：明确决策 vs 模糊倾向
- 决策 → `insertDecision`（含 embedding）
- 认知/品味 → 写 Markdown

---

## 6. 目录结构

```
openclaw-mesync/
├── openclaw.plugin.json      # manifest
├── package.json
├── tsconfig.json
├── DESIGN.md                 # 本文档
├── src/
│   ├── index.ts              # 插件入口（definePluginEntry + hook + tool 注册）
│   ├── config.ts             # 配置 schema
│   ├── db/
│   │   ├── schema.ts         # decisions 表结构
│   │   ├── connection.ts     # SQLite 连接
│   │   ├── decisions.ts      # 决策 CRUD + 向量检索
│   │   └── types.ts          # 类型定义
│   ├── embedding/
│   │   └── index.ts          # 复用 OpenClaw embedding provider
│   ├── tools/
│   │   └── recall.ts         # ocms_recall 工具
│   └── hooks/
│       ├── inject.ts         # before_prompt_build / Active Memory 注入
│       └── extract.ts        # agent_end 提取 + 写入门控
└── templates/                # 认知/品味 的规则模板（沿用 dsh-mesync 形态）
```

---

## 7. 复用 dsh-mesync 的部分

以下已验证逻辑直接沿用（适当调整宿主 API）：

- **决策表结构 + 因果链字段**（caused_by / supersedes / alternatives / taste_signals / scopes）
- **决策 CRUD**（insertDecision / getDecisionById / getRecentDecisions）
- **工具形态**：`recall`（摘要列表）+ `recall_detail`（单条详情）+ `remember`（手动记录）
- **模板机制**：`templates/rules/` + `templates/skills/` 下的 md 文件，顶层只注入「总纲」，其余按需 read

### ocms 的增量

- **embedding 列 + 向量检索**（替代关键词 LIKE）
- **宿主 API 换皮**：Cordis 的 `ctx.systemPrompt.section` / `ctx.on(...)` → OpenClaw 的 `definePluginEntry` / `api.on(...)` / Active Memory
- **升维语义**：字段和模板文案从「项目」升到「Agent 本体」

---

## 8. 待定 / 下一步

- [ ] 确认 config schema 字段（maxContextDecisions 等）
- [ ] 确认 embedding 复用方式（复用已注册 adapter vs 自己实例化）
- [ ] 确认 `agent_end` 提取的门控具体实现（轻量模型判断 vs 主模型标记）
- [ ] 数据落盘路径（`.ocms/` 还是跟随 OpenClaw workspace？）
