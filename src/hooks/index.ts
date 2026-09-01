// hooks/index — ocms 的 hook 层
// before_prompt_build：首次初始化 + 注入总纲 + 当前生效决策
// agent_end：轻量提示（skill 驱动，主 agent 自行提取）
//
// 宿主 API：OpenClaw 类型化 hook（api.on）。
// 提取机制复用 dsh-mesync：不后台 loop，而是「skill 注入 + 主 agent 自行提取」。

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry'
import {
  loadChain,
  listChains,
  getActiveNodes,
  readDecisionMarkdown,
  ensureTemplates,
  ensureDataDirs,
  loadStrategySkill,
} from '../store/index.js'
import type { OcmsConfig } from '../config.js'

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
  const { maxContextDecisions } = ocmsConfig

  // ---- before_prompt_build：初始化 + 注入总纲 + 当前生效决策 ----
  api.on('before_prompt_build', async (_event, ctx) => {
    const agentId = ctx?.agentId
    if (!agentId) return

    try {
      const agentDir = api.runtime.agent.resolveAgentDir(api.config, agentId)

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

      // 2. 注入总纲（始终注入，ocms 的设计基础）
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

  // ---- agent_end：轻量提示（skill 驱动，不自己做 LLM 提取） ----
  api.on('agent_end', async (event, ctx) => {
    const success = event?.success ?? false
    const agentId = ctx?.agentId
    if (!success || !agentId) return

    // 不做自动提取。提取由「总纲 skill」驱动，主 agent 在对话中自行判断
    // 何时调 ocms_remember / 写 cognition / 写 taste。
    // 这里仅记录调试日志。
    api.logger?.debug?.(`ocms agent_end: turn completed (agentId=${agentId})`)
  })
}
