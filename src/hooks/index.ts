// hooks/index — ocms 的 hook 层
// before_prompt_build：首次初始化 + 注入总纲 + 当前生效决策
// before_agent_finalize：收尾回顾兜底（revise 一轮，按回顾心法补漏落盘）
// agent_end：轻量调试日志
//
// 宿主 API：OpenClaw 类型化 hook（api.on）。
// 提取机制复用 dsh-mesync：不后台 loop，而是「skill 注入 + 主 agent 自行提取」。
// 回顾心法内容在 _sync_review.skill.md（提示词不硬编码在代码里）。

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry'
import {
  loadChain,
  listChains,
  getActiveNodes,
  readDecisionMarkdown,
  ensureTemplates,
  ensureDataDirs,
  loadStrategySkill,
  loadReviewSkill,
  loadEventIndex,
  listOpenEvents,
} from '../store/index.js'
import type { OcmsConfig } from '../config.js'
import { isAgentEnabled } from '../config.js'

interface RegisterHooksParams {
  api: OpenClawPluginApi
  ocmsConfig: OcmsConfig
}

function formatActiveDecision(agentDir: string, chainName: string, node: any): string {
  const md = readDecisionMarkdown(agentDir, chainName, node.markdown)
  const title = md.split('\n').find((l) => l.startsWith('# '))?.replace('# ', '') ?? node.id
  return `- [${chainName}] ${title}`
}

export function registerHooks({ api, ocmsConfig }: RegisterHooksParams): void {
  const { maxContextDecisions, agents } = ocmsConfig

  // ---- before_prompt_build：初始化 + 注入总纲 + 当前生效决策 ----
  api.on('before_prompt_build', async (_event, ctx) => {
    const agentId = ctx?.agentId
    if (!agentId) return
    // per-agent 白名单：不在名单内的 agent 跳过（agents 为空 = 全部）
    if (!isAgentEnabled(agents, agentId)) return

    try {
      const agentDir = api.runtime.agent.resolveAgentWorkspaceDir(api.config, agentId)

      // 首次初始化：数据目录 + 模板
      ensureDataDirs(agentDir)
      ensureTemplates(agentDir)

      const sections: string[] = []

      // 1. 注入当前生效决策（如果有）
      const chainNames = listChains(agentDir)
      const decisions: string[] = []
      let count = 0
      for (const name of chainNames) {
        if (count >= maxContextDecisions) break
        const chain = loadChain(agentDir, name)
        if (!chain) continue
        for (const node of getActiveNodes(chain)) {
          if (count >= maxContextDecisions) break
          decisions.push(formatActiveDecision(agentDir, name, node))
          count++
        }
      }
      if (decisions.length > 0) {
        sections.push('## 🔮 ocms 当前生效决策\n' + decisions.join('\n'))
      }

      // 2. 注入当前生效事件（对话连续性：让 Agent 知道「聊到哪了」）
      const eventIndex = loadEventIndex(agentDir)
      const openEvents = listOpenEvents(eventIndex).slice(0, maxContextDecisions)
      if (openEvents.length > 0) {
        // 区分两种状态，动作不同：
        //   open（只开不合，可能因对话突然中断/被迫重启）→ 直接延续，不询问
        //   asked（已问过）→ 不再重复问，等用户主动提
        const pending = openEvents.filter((e) => e.status === 'open')
        const asked = openEvents.filter((e) => e.status === 'asked')

        const lines: string[] = []
        if (pending.length > 0) {
          lines.push('**待接续（open，直接延续）**：')
          for (const e of pending) lines.push(`- [${e.id}] ${e.title}`)
        }
        if (asked.length > 0) {
          if (lines.length) lines.push('')
          lines.push('**已询问过（asked，不重复问）**：')
          for (const e of asked) lines.push(`- [${e.id}] ${e.title}`)
        }

        const guidance = [
          '> 以上是还未聊完的话题。',
          '> - **open** 状态：对话可能突然中断或被迫重启（如 /new）。本次开场时，**直接带出上下文自然延续**（如「接着上次的 X，我们继续…」），**不要询问**「要不要继续」。',
          '> - **asked** 状态：已经问过用户了，**不再重复询问**，等用户主动提。',
          '> - 延续过程中有进展时，用 ocms_event 更新；聊完时更新为 closed。',
        ].join('\n')

        sections.push('## 🔮 ocms 进行中事件（对话连续性）\n' + lines.join('\n') + '\n\n' + guidance)
      }

      // 3. 注入总纲（始终注入，ocms 的设计基础）
      const strategy = loadStrategySkill(agentDir)
      if (strategy.trim()) {
        sections.push(strategy.trim())
      }

      if (sections.length > 0) {
        return { appendSystemContext: sections.join('\n\n') }
      }
    } catch {
      // 注入失败不影响对话
    }
  })

  // ---- before_agent_finalize：收尾回顾兜底 ----------------
  // 主模型回复后、正式定稿前，拦截一次，注入「回顾心法」让 harness 再跑一轮。
  // 这轮模型按 _sync_review.skill.md 的指引，把这一轮漏记的决策/事件/认知/品味补上。
  // 回顾心法正文在 skill 文件里，这里只注入指向它的引导指令（提示词不硬编码）。
  api.on('before_agent_finalize', async (event, ctx) => {
    const agentId = ctx?.agentId
    if (!agentId) return
    if (!isAgentEnabled(agents, agentId)) return

    try {
      const agentDir = api.runtime.agent.resolveAgentWorkspaceDir(api.config, agentId)

      // 读取回顾心法（尊重用户版本；不存在/为空则跳过兜底）
      const reviewSkill = loadReviewSkill(agentDir)
      if (!reviewSkill.trim()) return

      // 把回顾心法内容作为 revise 指令注入。harness 会用这条指令再跑一轮模型 pass，
      // 这轮 pass 里模型会 read 到 .ocms 下的 skill 文件、按心法调 ocms 工具落盘。
      return {
        action: 'revise',
        reason: 'ocms 收尾回顾：按回顾心法补录本轮记忆',
        retry: {
          instruction: [
            '现在进行一轮「记忆收尾回顾」（由 ocms 插件触发，不是用户要求）。',
            '请先 read 这个心法文件并严格照做：' + agentDir + '/.ocms/skills/_sync_review.skill.md',
            '',
            '核心：把这一轮对话里漏记的决策/事件/认知/品味补进 .ocms/，然后静默结束。',
            '如果没有值得记的内容，什么都不做、不要生成面向用户的新回复。',
          ].join('\n'),
          // 只允许一轮回顾，避免 revise 死循环（回顾本身不应再触发回顾）
          maxAttempts: 1,
        },
      }
    } catch {
      // 回顾失败不影响主回复
    }
  })

  // ---- agent_end：轻量调试日志 ----------------
  api.on('agent_end', async (event, ctx) => {
    const success = event?.success ?? false
    const agentId = ctx?.agentId
    if (!success || !agentId) return
    if (!isAgentEnabled(agents, agentId)) return

    api.logger?.debug?.(`ocms agent_end: turn completed (agentId=${agentId})`)
  })
}
