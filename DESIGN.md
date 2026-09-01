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

1. **补上「决策向量检索」能力缺口** —— dsh-mesync 的决策检索只有关键词 LIKE 匹配，ocms 借 OpenClaw 原生 `memory_search` 补上向量检索。
2. **维度升层** —— dsh-mesync 面向「写代码」这一件事；ocms 面向 **Agent 本体**，三概念覆盖 Agent 能做的所有事（查资料、做判断、写代码、呈现、沟通……），不止写代码。

---

## 2. 核心设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 存储方式 | **Markdown 存内容 + JSON 存链拓扑**（方案 C） | 符合 OpenClaw「记忆即文件」哲学；零原生编译依赖 |
| 决策链 | **一条链 = 一个文件夹** | 相关决策物理聚在一起；`chain.json` 记录链结构 |
| 向量检索 | **路线 2 + 方案 B：ocms 自建向量检索，embedding 存在 chain.json** | 完全自控，为 mmos 探路；复用 OpenClaw embedding（零重复配置）；绕开 extraPaths 静态配置的坑 |
| 检索时机 | **ocms_recall 工具**（向量检索 + 因果链过滤） | 主 agent 自行调用；before_prompt_build 注入当前生效决策 |
| 更新时机 | **skill 注入 + 主 agent 自行提取** | 复用 dsh-mesync 验证哲学；不做 agent_end LLM 提取 |
| SQLite | **不用** | OpenClaw 插件依赖须纯 JS/TS，better-sqlite3 原生编译不友好 |
| 开发身份 | **wenliangw（糖豆）全权** | 糖豆独揽项目，不走「小明开发 + 糖豆 review」双人流程 |

---

## 3. 存储架构

数据落盘根目录：`.openclaw/agents/<agent-id>/.ocms/`（ocms 面向 Agent 本体，不同 agent 记忆隔离）

```
.openclaw/agents/<agent-id>/.ocms/
├── decisions/                      # 所有决策
│   ├── <chain-name>/               # 一条链 = 一个文件夹
│   │   ├── chain.json              # 链拓扑（JSON 数组，链表结构）
│   │   ├── decision-<id>.md        # 决策正文（Markdown）
│   │   └── ...
│   └── ...
├── cognition/                      # 认知（Markdown）
│   └── *.md
├── taste/                          # 品味（Markdown）
│   └── *.md
├── skills/                         # 提取 skill（从 templates 复制）
└── rules/                          # 提取 rule（从 templates 复制）
```

### 3.1 决策（Decisions）

决策是「枢纽」，以**因果链**串联。内容与结构分离：

- **内容** → `decision-<id>.md`（Markdown，人类可读 + 可被 `memory_search` 向量检索）
- **链拓扑** → `chain.json`（JSON 数组，天然链表结构）

#### chain.json 结构

```json
{
  "chainId": "api-design",
  "nodes": [
    {
      "id": "decision-001",
      "markdown": "decision-001.md",
      "created_at": "2026-09-01T10:00:00+08:00",
      "outcome": "superseded",
      "caused_by": [],
      "supersedes": [],
      "superseded_by": "decision-002",
      "scopes": []
    },
    {
      "id": "decision-002",
      "markdown": "decision-002.md",
      "outcome": "adopted",
      "caused_by": ["decision-001"],
      "supersedes": ["decision-001"],
      "superseded_by": null,
      "scopes": [],
      "embedding": [0.123, -0.456, ...]
    }
  ]
}
```

> `embedding` 字段：决策向量（浮点数组），`ocms_remember` 记录时趁热生成。`ocms_recall` 用它做余弦相似度检索。

#### 链表特性管理

| 特性 | 字段 | 说明 |
|------|------|------|
| 方向性 | `caused_by` / `supersedes` | 上游→下游；新→旧 |
| 多父节点 | `caused_by: string[]` | 一个决策可由多个决策引发 |
| 状态流转 | `outcome` | adopted / superseded / refined / pending |
| 反向指针 | `superseded_by` | 冗余指针，O(1) 定位「当前生效」 |
| 追加式 | 不覆盖历史 | 新决策 `supersedes` 指向旧决策，旧决策 `superseded_by` 指向新决策 |

**「当前生效决策」** = `superseded_by: null` 且 `outcome: adopted` 的节点。

#### 向量检索（路线 2 + 方案 B）

- **embedding 生成**：`ocms_remember` 记录时，对 `decision + rationale` 调 OpenClaw 的 memory embedding provider（`getMemoryEmbeddingProvider` → `embedBatch`）生成向量，存进 chain.json 的 node。
- **检索**：`ocms_recall(query)` 对 query 调 `embedQuery` 得 query 向量，与**当前生效决策**的 embedding 做余弦相似度，取 top-k。
- **复用 OpenClaw embedding**：provider + model + key 都从 `api.config` 的 `memorySearch` 读取，用户零重复配置。
- **降级**：未配置 embedding 时，退化为关键词匹配 + 因果链过滤。

#### 决策正文（decision-<id>.md）

```markdown
# 决策：<一句话决策>

- 触发：<trigger>
- 结论：<decision 完整表述>

## 理由（rationale）

...

## 备选方案（alternatives）

- 方案A：...（为何不选：...）

## 品味信号（taste_signals）

...
```

### 3.2 认知（Cognition）→ Markdown

认知 = Agent「世界是怎么运作的」知识/方法论。自由文本，存 `.openclaw/agents/<agent-id>/.ocms/cognition/*.md`，由主 agent 惰性生成/维护，OpenClaw `memory_search` 检索。

### 3.3 品味（Taste）→ Markdown

品味 = 用户/Agent 的审美、偏好、判断倾向。存 `.openclaw/agents/<agent-id>/.ocms/taste/*.md`，同样 `memory_search` 检索。

---

## 4. 三概念的升维语义

| 维度 | dsh-mesync（写代码） | ocms（Agent 本体） |
|------|---------------------|-------------------|
| 决策 | 代码实现方案取舍 | Agent 做任何事时的行动决策 |
| 认知 | 代码/架构知识 | 世界运作的知识、跨任务方法论 |
| 品味 | 代码风格偏好 | 广义审美/判断倾向 |

---

## 5. 运行链路

```
OpenClaw 主回复流程
  ↓
[before_prompt_build hook]         ← 回复前
  ├─ 首次：初始化数据目录 + 复制 templates 到 .ocms/
  ├─ 注入总纲（_sync_strategy.skill.md，始终注入）
  └─ 注入当前生效决策（因果链过滤）
  ↓
主模型回复（受总纲 skill 驱动，自行判断何时提取）
  ↓
[agent_end hook]                   ← 回复后（轻量，不自己做 LLM 提取）
```

### 提取机制：skill 注入 + 主 agent 自行提取（复用 dsh-mesync）

不做后台 loop，不做 agent_end 里的 LLM 门控提取。而是：

1. **总纲 skill 始终注入**：讲清三概念模型 + 何时提取 + 设计原则
2. **决策/认知/品味 skill 按需 read**：主 agent 需要时自己读
3. **ocms_remember 工具**：决策提取的落盘出口（写 md + 更新 chain.json）
4. **认知/品味写 md**：主 agent 用 write 工具直接写 .ocms/cognition/ 和 .ocms/taste/

这样提取质量最高（主 agent 全程在上下文里），成本最低（零额外 LLM 调用），且与 mesync 已验证哲学一致。

---

## 6. 目录结构

```
openclaw-mesync/
├── openclaw.plugin.json      # manifest
├── package.json
├── tsconfig.json
├── DESIGN.md
├── src/
│   ├── index.ts              # 插件入口（definePluginEntry）
│   ├── config.ts             # 配置（maxContextDecisions）
│   ├── store/
│   │   ├── paths.ts          # 数据路径解析（.openclaw/agents/<agent-id>/.ocms/）
│   │   ├── chain.ts          # chain.json 读写 + 链表操作 + 向量检索
│   │   ├── decision.ts       # 决策 md 读写
│   │   ├── templates.ts      # 模板管理（ensure/load）
│   │   └── index.ts
│   ├── embedding/
│   │   └── index.ts          # 复用 OpenClaw memory embedding provider
│   ├── tools/
│   │   └── index.ts          # ocms_recall / recall_detail / remember / chain
│   └── hooks/
│       └── index.ts          # before_prompt_build + agent_end
├── templates/                # 提取 skill/rule（复制到 .ocms/）
│   ├── skills/               # _sync_strategy / _sync_decision / _sync_taste / _sync_cognition
│   └── rules/                # _sync_decision
└── scripts/
    └── copy-assets.mjs       # 复制 templates 到 dist
```

---

## 7. 复用 dsh-mesync 的部分

- **三概念 + 因果链语义**（caused_by / supersedes / alternatives / taste_signals / scopes）
- **追加式决策链**（不覆盖历史，延伸因果链）
- **工具形态**：recall / recall_detail / remember（加 ocms_ 前缀）
- **模板机制**：顶层注入总纲，其余按需 read

### ocms 的增量

- **存储换皮**：SQLite → Markdown + JSON 链拓扑（符合 OpenClaw 生态）
- **向量检索**：自建 embedding 列 → 复用 OpenClaw memory embedding provider（`getMemoryEmbeddingProvider`），embedding 存 chain.json
- **宿主 API 换皮**：Cordis 事件 → OpenClaw 类型化 hook（`api.on`）
- **升维语义**：项目 → Agent 本体

---

## 8. 待定 / 下一步

- [x] 数据落盘路径：`.openclaw/agents/<agent-id>/.ocms/`
- [x] config：只保留 `maxContextDecisions`，插件 id `ocms`
- [x] 存储方式：Markdown 内容 + JSON 链拓扑（一条链一个文件夹）
- [x] 向量检索：路线 2 + 方案 B（embedding 存 chain.json，复用 OpenClaw memory embedding provider）
- [x] 提取机制：skill 注入 + 主 agent 自行提取（复用 dsh-mesync templates 升维）
