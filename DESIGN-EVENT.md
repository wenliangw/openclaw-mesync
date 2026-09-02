# ocms 事件层设计（Event Layer）— 对话连续性记忆

> 本文是 ocms 从「决策/认知/品味」（做事能力）向「事件」（沟通连续性）扩展的设计文档。
> 定位：为 Agent 提供**跨会话对话连续性**，弥补 OpenClaw 原生流水账记忆的短板，同时为 mmos 的「persistent soul」探路。

---

## 1. 为什么需要事件层

ocms 已有的「决策 / 认知 / 品味」覆盖的是 Agent **做事**的能力 —— 回答「这个项目怎么设计、为什么这么决定、什么品味」。

但 Agent 与用户**沟通**还需要另一层记忆 —— 回答「昨天聊了什么、还记得 xxx 吗」。这是**对话连续性**。

OpenClaw 原生记忆这块偏弱：
- 是流水账（`memory/*.md`），缺乏结构化摘要
- 跨会话容易断裂，依赖手动落盘
- 没有「话题开合」「事件关联」等认知结构

**核心动机**：记忆回忆的本质不是「存流水账」，而是让**重启会话后 Agent 能无缝接上之前的对话**。

**结论**：不重复造流水账（OpenClaw 已有），ocms 只做**摘要层 + 关联层 + 指针层**。

---

## 2. 事件（Event）实体

### 2.1 定位

事件 = 「发生了什么」的**结构化摘要**，不是原始流水账。它指向 OpenClaw 的原始记忆文件（`memory/YYYY-MM-DD.md`），摘要存 ocms，原文留在 OpenClaw。

### 2.2 状态机

事件有 **4 种状态**，核心是「开/合」不强制对称：

```
事件状态：
├─ OPEN（进行中）     — 正在聊，有继续的预期
├─ ASKED（已询问）    — 话题转向后已主动问过用户，等待回应
├─ CLOSED（合）       — 用户明确「继续并聊完」或「不聊了」
└─ DORMANT（沉底）    — 用户没回应，标记后不再主动管
```

**关键流转（全部用户驱动，Agent 只询问一次）：**

```
话题 A 进行中（OPEN）
  → 用户突然转向话题 B
  → 话题 B 结束
  → Agent 立即自然询问：「话题 A 还要继续吗？」（skill 引导，主 agent 完成）
  → 立即标记状态（ASKED）
  → 之后完全交给用户：
      ├─ 用户「继续」  → OPEN（重新打开，继续聊）
      ├─ 用户「不聊了」→ CLOSED
      └─ 用户沉默      → DORMANT（沉底，不再主动唤起）
           └─ 除非用户后续主动聊起（向量语义检索唤起）
```

### 2.3 核心规则（钉死）

1. **「合」是被动产生的，不主动封口**。没有「超时强制合」，只有用户明确表态才 CLOSED。
2. **「只开不合」是合法终态**（DORMANT），对应现实里大量「聊着聊着没下文」的话题。
3. **询问只有一次机会**：问过就标记 ASKED，无论结果如何不再重复提醒，避免「每次对话都唠叨」。
4. **立即询问，不等下次会话**：话题转向结束后当场问，最小化时间遗忘，及时拿到结果。
5. **唤起方式 = 查最近的 OPEN/ASKED 话题**：不需要 embedding 大海捞针，Agent 查事件表即得。embedding 只用于「已沉底历史事件的语义唤起」。

### 2.4 话题粒度：可嵌套（大含小）

事件按「话题」分，但话题可大可小：

- **大话题** → 可包含多个**小事件**（分组管理）
- **小话题** → 正常存为独立事件

```
事件（Event，可嵌套）
  └─ 大话题（父事件）
       ├─ 小事件 1
       ├─ 小事件 2
       └─ 小事件 3
```

**skill 方法论**：告诉 Agent 大话题需要分组管理（父事件含子事件），小话题正常存。由 Agent 自行判断话题粒度和归属。

---

## 3. 关系模型（新增）

四类实体 + 三类关系：

### 3.1 实体

| 实体 | 状态/结构 | 存储 |
|------|----------|------|
| 事件 Event | OPEN/ASKED/CLOSED/DORMANT，可嵌套 | 摘要 md + 事件索引 |
| 决策 Decision | 因果链（已有） | decision-<id>.md + chain.json |
| 认知 Cognition | 自由文本（已有） | cognition/*.md |
| 品味 Taste | 自由文本（已有） | taste/*.md |

### 3.2 关系

```
事件 → 决策    「产生自」（事件催生决策，决策是事件的产物）
事件 → 事件    「影响」（单向，不分强度，多对多）
决策 → 决策    「因果链」（已有：caused_by / supersedes）
```

#### 关系 1：事件 → 决策（产生自）

- 决策从事件中产出，决策必溯源到至少一个事件
- 决策不能凭空存在

#### 关系 2：事件 → 事件（影响）

三条铁律：

1. **单向** —— 时间线性单向，A 影响 B，B 不反向影响 A
2. **不分强度** —— 只建边，不标权重；受影响程度由 Agent 需要时检索两事件联合上下文自行判断
3. **多对多** —— 一个事件可影响多个事件，也可被多个事件影响，只关联即可

**判断者**：主 Agent 在沉淀记忆时，自行判断「当前事件是否和之前某事件有关」。

#### 关系 3：决策 → 决策（因果链，已有）

沿用现有 `caused_by` / `supersedes` / `superseded_by`。

---

## 4. 统一沉淀动作

事件、决策、关系都在**同一个记忆沉淀动作**里，由主 Agent 一次性完成，不是独立后台任务。

skill 引导 Agent 在沉淀记忆时完成三件事：

```
1. 这个对话是否结束？
   → 生成/更新事件摘要，定状态（OPEN/ASKED/CLOSED/DORMANT）

2. 这个事件产生了什么决策？
   → 建「产生自」边（事件 → 决策）

3. 这个事件和之前哪些事件有关？
   → 建「影响」边（多对多，单向）
```

### 触发时机

- **事件摘要生成**：每次对话**结束时**，skill/rule 注入引导 Agent 判断「对话是否结束」
  - 已闭环 → 整理摘要 → 存事件
  - 未完 → 延续事件（保持 OPEN）
- **关系建立**：随事件摘要生成一起完成

---

## 5. 物理地址指针

事件摘要指向 OpenClaw 原始流水账，方便检索时回溯完整上下文。

### 5.1 OpenClaw 记忆文件写入行为（已查证）

| 文件 | 写入行为 | 指针稳定性 |
|------|---------|-----------|
| `memory/YYYY-MM-DD.md`（daily notes） | **只增不改**（按日期追加） | ✅ 高 |
| `MEMORY.md`（长期记忆） | 会**提炼 + 删过期条目**（dreaming deep phase） | ⚠️ 会被改写 |
| session transcript（.jsonl） | 会被 reset / 归档 / 清理 | ❌ 易失效 |

**结论**：
- 精准指针**优先指向 daily notes**（只增不改，最稳定）
- **不指向 `MEMORY.md`**（会被改写）
- **不指向 transcript**（会被归档清理）

### 5.2 指针设计（两层）

| 层级 | 内容 | 用途 |
|------|------|------|
| 精准指针 source_refs | `file` + `anchor`（段落标题/锚文本，不用死行号） | 溯源到原始记录 |
| 粗粒度兜底 fallback | keywords + embedding | 精准指针对不上时降级检索 |

> **anchor 用「段落标题 / 独特锚文本」而非行号**：行号会因追加而偏移，锚文本在追加场景下更稳定，可做子串匹配定位。

### 5.3 skill 引导（防指针失效）

```
1. 检索到事件摘要 → 先按 source_refs 找原文
2. 打开文件核对，内容对不上（文件被改/段落偏移）→ 降级用 fallback 关键词/向量重新检索
3. 永远不「硬信任」指针，核对是必须步骤
```

### 5.4 数据结构示例

```json
{
  "id": "event-2026-09-01-ocms-memory",
  "title": "讨论 ocms 补对话记忆能力",
  "summary": "...",
  "status": "CLOSED",
  "parent": null,
  "children": [],
  "source_refs": [
    { "file": "memory/2026-09-01.md", "anchor": "## ocms 对话记忆", "confidence": "high" }
  ],
  "fallback": {
    "keywords": ["ocms", "对话记忆", "事件"],
    "embedding": [0.1, -0.2, ...]
  },
  "produced_decisions": ["decision-xxx"],
  "influences": ["event-yyy"]
}
```

---

## 6. 事件层存储架构

```
.openclaw/agents/<agent-id>/.ocms/
├── events/                         # 新增：事件层
│   ├── index.json                  # 事件索引（状态/层级/关系/指针，类似 chain.json 的角色）
│   └── event-<id>.md               # 事件摘要正文（Markdown，可被 memory_search 检索）
├── decisions/                      # 已有
├── cognition/                      # 已有
├── taste/                          # 已有
├── skills/                         # 已有 + 新增事件提取 skill
└── rules/                          # 已有 + 新增事件提取 rule
```

### index.json（事件索引）

```json
{
  "events": [
    {
      "id": "event-001",
      "markdown": "event-001.md",
      "title": "...",
      "status": "OPEN",
      "parent": null,
      "children": ["event-002"],
      "created_at": "...",
      "updated_at": "...",
      "produced_decisions": ["decision-xxx"],
      "influences": ["event-yyy"],
      "embedding": [0.1, -0.2, ...]
    }
  ]
}
```

### 事件摘要正文（event-<id>.md）

```markdown
# 事件：<一句话事件>

- 状态：OPEN / ASKED / CLOSED / DORMANT
- 时间：<起止时间>
- 来源：memory/2026-09-01.md（锚：## ocms 对话记忆）

## 摘要

...

## 产生的决策

- decision-xxx

## 影响的事件

- event-yyy（单向）
```

---

## 7. 运行链路（扩展）

```
OpenClaw 主回复流程
  ↓
[before_prompt_build hook]         ← 回复前
  ├─ 注入总纲（三概念 + 事件模型 + 提取方法论）
  ├─ 注入当前生效决策（因果链过滤）
  └─ 注入「最近的 OPEN/ASKED 事件」（对话连续性，让 Agent 知道聊到哪了）
  ↓
主模型回复（受 skill 驱动）
  ↓
[agent_end hook]                   ← 回复后
  └─ 注入事件沉淀 skill，引导 Agent 判断对话是否结束、生成摘要、建关系
```

### 新增工具

- `ocms_event` — 记录/更新事件（生成摘要、定状态）
- `ocms_event_list` — 列出最近的 OPEN/ASKED 事件（唤起未完成话题）
- `ocms_event_recall` — 向量检索历史事件（唤起沉底事件）

---

## 8. 为 mmos 做准备

事件层是 mmos「persistent soul」的关键预研：

| 能力 | ocms 事件层 | mmos 映射 |
|------|-----------|----------|
| 对话连续性 | OPEN/ASKED 事件注入 | 跨会话「工作记忆」 |
| 历史唤起 | DORMANT 事件向量检索 | 语义记忆召回 |
| 因果溯源 | 事件 → 决策「产生自」 | 决策的上下文根 |
| 事件关联 | 事件 → 事件「影响」 | 情景记忆（episodic）网络 |
| 话题分组 | 大事件含小事件 | 记忆的层级组织 |

---

## 9. 待定 / 下一步

- [x] 事件层数据模型（index.json + event md）落地
- [x] 事件状态机实现（OPEN/ASKED/CLOSED/DORMANT）
- [x] 事件关系（产生自 / 影响）实现
- [x] 事件提取 skill/rule 模板（含「对话是否结束」判断 + 话题分组方法论）
- [x] 事件工具（ocms_event / ocms_event_list / ocms_event_recall / ocms_event_detail）
- [x] before_prompt_build 注入「最近 OPEN/ASKED 事件」
- [ ] agent_end 注入事件沉淀引导（当前靠总纲 skill 驱动，agent_end 保持轻量）
- [x] 物理指针（source_refs + fallback + 核对降级）
- [ ] 端到端实测（真实 OpenClaw 环境验证事件闭环）
