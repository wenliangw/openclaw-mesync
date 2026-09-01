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
    const agentDir = ctx.agentDir ?? null
    const config: OpenClawConfig | undefined = ctx.config ?? ctx.runtimeConfig ?? ctx.getRuntimeConfig?.()
    if (!agentDir) return null

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

    return [recall, recallDetail, remember, chainTool]
  }
}
