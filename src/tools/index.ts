// tools/index — ocms 的 Agent 工具
// ocms_recall（当前生效决策摘要，因果链过滤）
// ocms_recall_detail（单条决策完整内容）
// ocms_remember（手动记录决策，追加到链）
// ocms_chain（查看某条链的完整因果链）
//
// 向量检索不在这里做：决策 md 由 OpenClaw 原生 memory_search 检索。
// ocms 工具的核心价值是「因果链过滤」——只暴露当前生效决策，隐藏被取代的旧决策。

import { Type } from 'typebox'
import type { AnyAgentTool } from 'openclaw/plugin-sdk/plugin-entry'
import {
  loadChain,
  listChains,
  appendNode,
  getActiveNodes,
  traceCausalChain,
  readDecisionMarkdown,
} from '../store/index.js'
import type { DecisionContent } from '../store/index.js'

let currentCwd: string | null = null

export function setToolCwd(cwd: string | null): void {
  currentCwd = cwd
}

function getCwdOrThrow(): string {
  if (!currentCwd) throw new Error('ocms not initialized (no active workspace).')
  return currentCwd
}

export function buildTools(): AnyAgentTool[] {
  // ---- ocms_recall — 列出当前生效的决策摘要 ----
  const recall: AnyAgentTool = {
    name: 'ocms_recall',
    label: 'Recall decisions',
    description:
      '列出 ocms 中「当前生效」的决策摘要（自动隐藏被取代的旧决策）。' +
      '可选按 chain 或 query 过滤。需要看某条决策完整内容时，用 ocms_recall_detail。',
    parameters: Type.Object({
      chain: Type.Optional(Type.String({ description: '只看某条链（文件夹名），如 api-design。' })),
      query: Type.Optional(Type.String({ description: '关键词匹配决策内容。' })),
      limit: Type.Optional(Type.Number({ description: '最多返回几条（默认 20）。' })),
    }),
    async execute(_toolCallId: string, params: unknown): Promise<any> {
      const p = params as { chain?: string; query?: string; limit?: number }
      const cwd = getCwdOrThrow()
      const limit = p.limit ?? 20
      const chainNames = p.chain ? [p.chain] : listChains(cwd)

      const parts: string[] = []
      let count = 0

      for (const name of chainNames) {
        const chain = loadChain(cwd, name)
        if (!chain) continue
        let active = getActiveNodes(chain)
        if (p.query) {
          const q = p.query.toLowerCase()
          active = active.filter((n) => {
            const md = readDecisionMarkdown(cwd, name, n.markdown)
            return (n.id + ' ' + md).toLowerCase().includes(q)
          })
        }
        for (const node of active) {
          if (count >= limit) break
          parts.push(`- [${chain.chainId}] ${node.id} · **${node.markdown.replace('.md', '')}**`)
          count++
        }
      }

      if (parts.length === 0) return 'No active decisions found.'
      parts.unshift('## Active Decisions')
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
      const cwd = getCwdOrThrow()
      const chain = loadChain(cwd, p.chain)
      if (!chain) return `No chain found: ${p.chain}`

      const node = chain.nodes.find((n) => n.id === p.id)
      if (!node) return `No decision ${p.id} in chain ${p.chain}.`

      const md = readDecisionMarkdown(cwd, p.chain, node.markdown)
      const parts = [md, '']
      parts.push('## 因果链位置')
      parts.push(`- outcome: ${node.outcome}`)
      if (node.caused_by.length) parts.push(`- caused_by: ${node.caused_by.join(', ')}`)
      if (node.supersedes.length) parts.push(`- supersedes: ${node.supersedes.join(', ')}`)
      if (node.superseded_by) parts.push(`- superseded_by: ${node.superseded_by}`)
      return parts.join('\n')
    },
  }

  // ---- ocms_remember — 手动记录决策（追加到链） ----
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
      const cwd = getCwdOrThrow()

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
      const { writeDecisionMarkdown } = await import('../store/decision.js')
      writeDecisionMarkdown(cwd, args.chain, fileName, content)

      // 更新链拓扑
      appendNode(
        cwd,
        args.chain,
        {
          id,
          markdown: fileName,
          created_at: new Date().toISOString(),
          outcome: 'adopted',
          caused_by: causedBy,
          supersedes: supersedes,
          scopes: [],
        },
        supersedes,
      )

      return `✅ Decision recorded in chain "${args.chain}": **${args.decision}** (${id})`
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
      const cwd = getCwdOrThrow()
      const chain = loadChain(cwd, p.chain)
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

  return [recall, recallDetail, remember, chainTool]
}
