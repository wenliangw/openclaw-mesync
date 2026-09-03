// tools/index — ocms 的 Agent 工具
// ocms_recall（向量检索当前生效决策，因果链过滤）
// ocms_recall_detail（单条决策完整内容）
// ocms_remember（手动记录决策，追加到链，生成 embedding）
// ocms_chain（查看某条链的完整因果链）
//
// 工具用 factory 形式：从 toolContext 拿 agentDir + config，闭包进工具。
// 向量检索（路线 2 + 方案 B）：embedding 存在 chain.json 的 node 里，
// recall 时用 OpenClaw 的 memory embedding provider 做 query embedding + 余弦检索。
// 降级：无 embedding 配置时退化为关键词匹配。

import { Type } from 'typebox'
import type { AnyAgentTool, OpenClawPluginToolContext, OpenClawConfig } from 'openclaw/plugin-sdk/plugin-entry'
import {
  loadChain,
  listChains,
  appendNode,
  getActiveNodes,
  searchDecisionsByVector,
  readDecisionMarkdown,
  writeDecisionMarkdown,
  loadEventIndex,
  findEvent,
  upsertEvent,
  setEventStatus,
  listOpenEvents,
  searchEventsByVector,
  readEventMarkdown,
  writeEventMarkdown,
} from '../store/index.js'
import { embedQuery, embedDocument } from '../embedding/index.js'
import type { DecisionContent } from '../store/index.js'

/** 从决策 md 提取标题（第一行 # 后面的内容） */
function decisionTitle(md: string, fallback: string): string {
  return md.split('\n').find((l) => l.startsWith('# '))?.replace('# ', '') ?? fallback
}

/** 工具 factory：从 toolContext 解析 agentDir + config，构建所有 ocms 工具 */
export function buildOcmsToolFactory() {
  return (ctx: OpenClawPluginToolContext): AnyAgentTool[] | null => {
    const agentDir = ctx.workspaceDir ?? ctx.agentDir ?? null
    const agentId = ctx.agentId ?? null
    const config: OpenClawConfig | undefined = ctx.config ?? ctx.runtimeConfig ?? ctx.getRuntimeConfig?.()
    if (!agentDir) return null

    // per-agent 白名单：从插件 config 读 agents，空 = 全部启用
    const agentAllowlist: string[] | undefined =
      (config as any)?.plugins?.entries?.ocms?.config?.agents ?? (config as any)?.plugins?.entries?.['openclaw-mesync']?.config?.agents
    if (agentAllowlist && agentAllowlist.length > 0 && agentId && !agentAllowlist.includes(agentId)) {
      return null
    }

    // ---- ocms_recall — 向量检索当前生效的决策摘要 ----
    const recall: AnyAgentTool = {
      name: 'ocms_recall',
      label: 'Recall decisions',
      description:
        '检索 ocms 中「当前生效」的决策（自动隐藏被取代的旧决策）。' +
        '支持语义向量检索（query）或按链浏览。需要看某条决策完整内容时，用 ocms_recall_detail。',
      parameters: Type.Object({
        query: Type.Optional(Type.String({ description: '要匹配的任务/问题描述，用于语义检索相关决策。' })),
        chain: Type.Optional(Type.String({ description: '只看某条链（文件夹名），如 api-design。' })),
        limit: Type.Optional(Type.Number({ description: '最多返回几条（默认 5）。' })),
      }),
      async execute(_toolCallId: string, params: unknown): Promise<any> {
        const p = params as { query?: string; chain?: string; limit?: number }
        const limit = p.limit ?? 5
        const chainNames = p.chain ? [p.chain] : listChains(agentDir)

        // 向量检索路径
        if (p.query && config) {
          const queryVec = await embedQuery(config, p.query)
          if (queryVec) {
            const scored: Array<{ title: string; chainId: string; id: string; score: number }> = []
            for (const name of chainNames) {
              const chain = loadChain(agentDir, name)
              if (!chain) continue
              for (const r of searchDecisionsByVector(chain, queryVec, limit)) {
                const md = readDecisionMarkdown(agentDir, name, r.node.markdown)
                scored.push({
                  title: decisionTitle(md, r.node.id),
                  chainId: chain.chainId,
                  id: r.node.id,
                  score: r.score,
                })
              }
            }
            scored.sort((a, b) => b.score - a.score)
            const top = scored.slice(0, limit)
            if (top.length > 0) {
              const parts = ['## Active Decisions (semantic)']
              for (const s of top) {
                parts.push(`- [${s.chainId}] ${s.id} · **${s.title}** (${(s.score * 100).toFixed(0)}%)`)
              }
              parts.push('', 'Use ocms_recall_detail to read the full rationale of a specific decision.')
              return parts.join('\n')
            }
          }
        }

        // 降级 / 浏览路径：关键词匹配 + 因果链过滤
        // 语义精判交给主 Agent（工具只给候选，不自己判语义）。
        const parts: string[] = []
        let count = 0
        for (const name of chainNames) {
          const chain = loadChain(agentDir, name)
          if (!chain) continue
          let active = getActiveNodes(chain)
          if (p.query) {
            const q = p.query.toLowerCase()
            active = active.filter((n) => {
              const md = readDecisionMarkdown(agentDir, name, n.markdown)
              return (n.id + ' ' + md).toLowerCase().includes(q)
            })
          }
          for (const node of active) {
            if (count >= limit) break
            const md = readDecisionMarkdown(agentDir, name, node.markdown)
            parts.push(`- [${chain.chainId}] ${node.id} · **${decisionTitle(md, node.id)}**`)
            count++
          }
        }

        if (parts.length === 0) return 'No active decisions found.'
        parts.unshift('## Active Decisions (keyword)')
        if (p.query) {
          parts.push('', '> 当前为关键词匹配（未启用向量检索）。如需语义召回，可开启 OpenClaw 的向量记忆插件（memory-lancedb）。多组关键词可提高召回率。')
        }
        parts.push('', 'Use ocms_recall_detail to read the full rationale of a specific decision.')
        return parts.join('\n')
      },
    }

    // ---- ocms_recall_detail — 单条决策完整内容 ----
    const recallDetail: AnyAgentTool = {
      name: 'ocms_recall_detail',
      label: 'Read decision detail',
      description: '读取单条决策的完整内容（rationale、alternatives、taste_signals）及其因果链位置。',
      parameters: Type.Object({
        chain: Type.String({ description: '决策所在链（文件夹名）。' }),
        id: Type.String({ description: '决策 id。' }),
      }),
      async execute(_toolCallId: string, params: unknown): Promise<any> {
        const p = params as { chain: string; id: string }
        const chain = loadChain(agentDir, p.chain)
        if (!chain) return `No chain found: ${p.chain}`

        const node = chain.nodes.find((n) => n.id === p.id)
        if (!node) return `No decision ${p.id} in chain ${p.chain}.`

        const md = readDecisionMarkdown(agentDir, p.chain, node.markdown)
        const parts = [md, '']
        parts.push('## 因果链位置')
        parts.push(`- outcome: ${node.outcome}`)
        if (node.caused_by.length) parts.push(`- caused_by: ${node.caused_by.join(', ')}`)
        if (node.supersedes.length) parts.push(`- supersedes: ${node.supersedes.join(', ')}`)
        if (node.superseded_by) parts.push(`- superseded_by: ${node.superseded_by}`)
        return parts.join('\n')
      },
    }

    // ---- ocms_remember — 手动记录决策（追加到链 + 生成 embedding） ----
    const remember: AnyAgentTool = {
      name: 'ocms_remember',
      label: 'Record decision',
      description:
        '记录一条决策到 ocms。追加式：如果取代旧决策，旧决策会被标记 superseded 而非删除。',
      parameters: Type.Object({
        chain: Type.String({ description: '决策链名（文件夹名），如 api-design。' }),
        decision: Type.String({ description: '一句话决策。' }),
        rationale: Type.String({ description: '为什么这么定。' }),
        trigger: Type.Optional(Type.String({ description: '触发情境。' })),
        alternatives: Type.Optional(Type.String({ description: 'JSON 数组 [{option, why_not}]。' })),
        taste_signals: Type.Optional(Type.String({ description: 'JSON 数组 [{signal, context}]。' })),
        supersedes: Type.Optional(Type.String({ description: '被本决策取代的旧决策 id（逗号分隔）。' })),
        caused_by: Type.Optional(Type.String({ description: '引发本决策的上游决策 id（逗号分隔）。' })),
      }),
      async execute(_toolCallId: string, params: unknown): Promise<any> {
        const args = params as any

        const id = `decision-${Date.now().toString(36)}`
        const fileName = `${id}.md`

        let alts: Array<{ option: string; why_not: string }> = []
        let tastes: Array<{ signal: string; context: string }> = []
        try {
          if (args.alternatives) alts = JSON.parse(args.alternatives)
          if (args.taste_signals) tastes = JSON.parse(args.taste_signals)
        } catch {
          /* ignore */
        }

        const content: DecisionContent = {
          decision: args.decision,
          trigger: args.trigger || null,
          rationale: args.rationale,
          alternatives: alts,
          taste_signals: tastes,
        }

        const supersedes = args.supersedes
          ? args.supersedes.split(',').map((s: string) => s.trim()).filter(Boolean)
          : []
        const causedBy = args.caused_by
          ? args.caused_by.split(',').map((s: string) => s.trim()).filter(Boolean)
          : []

        // 写决策正文
        writeDecisionMarkdown(agentDir, args.chain, fileName, content)

        // 趁热生成 embedding（decision + rationale 的语义）
        let embedding: number[] | null = null
        if (config) {
          embedding = await embedDocument(config, `${args.decision} ${args.rationale}`)
        }

        // 更新链拓扑（含 embedding）
        appendNode(
          agentDir,
          args.chain,
          {
            id,
            markdown: fileName,
            created_at: new Date().toISOString(),
            outcome: 'adopted',
            caused_by: causedBy,
            supersedes: supersedes,
            scopes: [],
            embedding,
          },
          supersedes,
        )

        return `✅ Decision recorded in chain "${args.chain}": **${args.decision}** (${id})${embedding ? ' [embedded]' : ''}`
      },
    }

    // ---- ocms_chain — 查看完整因果链 ----
    const chainTool: AnyAgentTool = {
      name: 'ocms_chain',
      label: 'View decision chain',
      description: '查看某条链的完整因果链结构（从根到当前生效节点的演化路径）。',
      parameters: Type.Object({
        chain: Type.String({ description: '决策链名（文件夹名）。' }),
      }),
      async execute(_toolCallId: string, params: unknown): Promise<any> {
        const p = params as { chain: string }
        const chain = loadChain(agentDir, p.chain)
        if (!chain) return `No chain found: ${p.chain}`

        const parts = [`## Chain: ${chain.chainId}`]
        const activeIds = new Set(getActiveNodes(chain).map((n) => n.id))

        for (const node of chain.nodes) {
          const mark = activeIds.has(node.id) ? '🟢' : '⚪'
          const supersededBy = node.superseded_by ? ` → superseded by ${node.superseded_by}` : ''
          parts.push(`${mark} ${node.id} (${node.outcome})${supersededBy}`)
        }
        return parts.join('\n')
      },
    }

    // ---- ocms_event — 记录/更新事件 ----------------
    const eventTool: AnyAgentTool = {
      name: 'ocms_event',
      label: 'Record event',
      description:
        '记录或更新一个事件（对话话题的摘要）。事件解决对话连续性：跨会话接上之前聊过的话题。' +
        '字段：title（一句话标题）、summary（摘要）、status（open/asked/closed/dormant）、' +
        'parent（父事件 id，大话题分组用）、produced_decisions（产生的决策 id）、' +
        'influences（影响的事件 id）、source_refs（指向 memory/*.md 的原始记录）。',
      parameters: Type.Object({
        id: Type.Optional(Type.String({ description: '事件 id。留空则自动生成（新建）。' })),
        title: Type.String({ description: '事件一句话标题（可检索摘要字段）。' }),
        summary: Type.String({ description: '事件摘要：聊了什么、结论、停在哪。' }),
        status: Type.Optional(Type.String({ description: '状态：open/asked/closed/dormant（默认 open）。' })),
        parent: Type.Optional(Type.String({ description: '父事件 id（大话题分组用）。' })),
        produced_decisions: Type.Optional(Type.String({ description: '产生的决策 id（逗号分隔）。' })),
        influences: Type.Optional(Type.String({ description: '影响的事件 id（逗号分隔）。' })),
        source_refs: Type.Optional(Type.String({ description: 'JSON 数组 [{file, anchor}]，指向 memory/*.md。' })),
      }),
      async execute(_toolCallId: string, params: unknown): Promise<any> {
        const args = params as any
        const id = args.id || `event-${Date.now().toString(36)}`
        const status = (['open', 'asked', 'closed', 'dormant'].includes(args.status) ? args.status : 'open') as any
        const fileName = `${id}.md`

        let refs: Array<{ file: string; anchor: string; confidence?: string }> = []
        try {
          if (args.source_refs) refs = JSON.parse(args.source_refs)
        } catch {
          /* ignore */
        }

        const produced = args.produced_decisions
          ? args.produced_decisions.split(',').map((s: string) => s.trim()).filter(Boolean)
          : []
        const influences = args.influences
          ? args.influences.split(',').map((s: string) => s.trim()).filter(Boolean)
          : []

        // 写事件正文
        const mdParts = [
          `# 事件：${args.title}`,
          '',
          `- 状态：${status}`,
          `- 时间：${new Date().toISOString()}`,
        ]
        if (refs.length) {
          mdParts.push('', '## 来源')
          for (const r of refs) mdParts.push(`- ${r.file}${r.anchor ? `（锚：${r.anchor}）` : ''}`)
        }
        mdParts.push('', '## 摘要', '', args.summary)
        if (produced.length) mdParts.push('', '## 产生的决策', ...produced.map((d: string) => `- ${d}`))
        if (influences.length) mdParts.push('', '## 影响的事件', ...influences.map((e: string) => `- ${e}`))
        writeEventMarkdown(agentDir, fileName, mdParts.join('\n'))

        // 趁热生成 embedding
        let embedding: number[] | null = null
        if (config) embedding = await embedDocument(config, `${args.title} ${args.summary}`)

        // 更新索引
        upsertEvent(agentDir, {
          id,
          markdown: fileName,
          title: args.title,
          summary: args.summary,
          status,
          parent: args.parent || null,
          produced_decisions: produced,
          influences,
          source_refs: refs,
          embedding,
        })

        return `✅ Event recorded: **${args.title}** (${id}, ${status})${embedding ? ' [embedded]' : ''}`
      },
    }

    // ---- ocms_event_list — 列出进行中事件（对话连续性） ----------------
    const eventListTool: AnyAgentTool = {
      name: 'ocms_event_list',
      label: 'List open events',
      description:
        '列出最近的「进行中」事件（open 或 asked）。用于接续未完成话题：话题转向后，' +
        '先查这里看有哪些话题还没聊完，需要确认是否继续。',
      parameters: Type.Object({
        limit: Type.Optional(Type.Number({ description: '最多返回几条（默认 10）。' })),
      }),
      async execute(_toolCallId: string, params: unknown): Promise<any> {
        const p = params as { limit?: number }
        const index = loadEventIndex(agentDir)
        const open = listOpenEvents(index).slice(0, p.limit ?? 10)
        if (open.length === 0) return 'No open events.'
        const parts = ['## Open Events']
        for (const e of open) {
          const mark = e.status === 'asked' ? '❓' : '🔵'
          parts.push(`${mark} ${e.id} [${e.status}] · **${e.title}**`)
          if (e.summary) parts.push(`  ${e.summary.slice(0, 120)}`)
        }
        return parts.join('\n')
      },
    }

    // ---- ocms_event_recall — 向量检索历史事件（唤起沉底事件） ----------------
    const eventRecallTool: AnyAgentTool = {
      name: 'ocms_event_recall',
      label: 'Recall events',
      description:
        '语义检索历史事件（包括已沉底的事件）。用户主动聊起某个久远话题时，用它找回相关事件。' +
        '需要看某事件完整内容，用 ocms_event_detail。',
      parameters: Type.Object({
        query: Type.String({ description: '要匹配的话题描述。' }),
        limit: Type.Optional(Type.Number({ description: '最多返回几条（默认 5）。' })),
      }),
      async execute(_toolCallId: string, params: unknown): Promise<any> {
        const p = params as { query: string; limit?: number }
        const limit = p.limit ?? 5
        const index = loadEventIndex(agentDir)

        // 向量检索
        if (config) {
          const queryVec = await embedQuery(config, p.query)
          if (queryVec) {
            const scored = searchEventsByVector(index, queryVec, limit)
            if (scored.length > 0) {
              const parts = ['## Events (semantic)']
              for (const s of scored) {
                parts.push(`- ${s.event.id} [${s.event.status}] · **${s.event.title}** (${(s.score * 100).toFixed(0)}%)`)
              }
              parts.push('', 'Use ocms_event_detail to read the full summary.')
              return parts.join('\n')
            }
          }
        }

        // 降级：关键词匹配（语义精判交给主 Agent）
        const q = p.query.toLowerCase()
        const hits = index.events
          .filter((e) => (e.title + ' ' + e.summary).toLowerCase().includes(q))
          .slice(0, limit)
        if (hits.length === 0) return 'No matching events found.'
        const parts = ['## Events (keyword)']
        for (const e of hits) parts.push(`- ${e.id} [${e.status}] · **${e.title}**`)
        parts.push('', '> 当前为关键词匹配（未启用向量检索）。如需语义召回，可开启 OpenClaw 的向量记忆插件（memory-lancedb）。多组关键词可提高召回率。')
        return parts.join('\n')
      },
    }

    // ---- ocms_event_detail — 单条事件完整内容 ----------------
    const eventDetailTool: AnyAgentTool = {
      name: 'ocms_event_detail',
      label: 'Read event detail',
      description: '读取单条事件的完整摘要、关系（产生的决策 / 影响的事件）和来源指针。',
      parameters: Type.Object({
        id: Type.String({ description: '事件 id。' }),
      }),
      async execute(_toolCallId: string, params: unknown): Promise<any> {
        const p = params as { id: string }
        const index = loadEventIndex(agentDir)
        const event = findEvent(index, p.id)
        if (!event) return `No event found: ${p.id}`

        const md = readEventMarkdown(agentDir, event.markdown)
        const parts = [md || `# 事件：${event.title}\n\n${event.summary}`, '']
        parts.push('## 关系')
        parts.push(`- status: ${event.status}`)
        if (event.parent) parts.push(`- parent: ${event.parent}`)
        if (event.children.length) parts.push(`- children: ${event.children.join(', ')}`)
        if (event.produced_decisions.length) parts.push(`- 产生的决策: ${event.produced_decisions.join(', ')}`)
        if (event.influences.length) parts.push(`- 影响的事件: ${event.influences.join(', ')}`)
        if (event.source_refs.length) {
          parts.push('## 来源')
          for (const r of event.source_refs) parts.push(`- ${r.file}${r.anchor ? `（锚：${r.anchor}）` : ''}`)
        }
        return parts.join('\n')
      },
    }

    return [recall, recallDetail, remember, chainTool, eventTool, eventListTool, eventRecallTool, eventDetailTool]
  }
}
