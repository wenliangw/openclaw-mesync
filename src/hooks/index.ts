// hooks/index — ocms 的 hook 层
// before_prompt_build：回复前注入当前生效决策
// agent_end：回复后提取决策/认知/品味（门控写入）
//
// 宿主 API：OpenClaw 类型化 hook（api.on）。

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry'
import { loadChain, listChains, getActiveNodes, readDecisionMarkdown } from '../store/index.js'
import { setToolCwd } from '../tools/index.js'
import type { OcmsConfig } from '../config.js'

interface RegisterHooksParams {
  api: OpenClawPluginApi
  ocmsConfig: OcmsConfig
}

function formatActiveDecision(cwd: string, chainName: string, node: any): string {
  const md = readDecisionMarkdown(cwd, chainName, node.markdown)
  // 只取决策标题行，避免注入过长
  const title = md.split('\n').find((l) => l.startsWith('# '))?.replace('# ', '') ?? node.id
  return `- [${chainName}] ${title}`
}

export function registerHooks({ api, ocmsConfig }: RegisterHooksParams): void {
  const { maxContextDecisions } = ocmsConfig

  // ---- before_prompt_build：注入当前生效决策 ----
  api.on('before_prompt_build', async (event, ctx) => {
    const cwd = ctx?.workspaceDir
    if (!cwd) return

    try {
      setToolCwd(cwd)

      const sections: string[] = []
      const chainNames = listChains(cwd)
      let count = 0

      for (const name of chainNames) {
        if (count >= maxContextDecisions) break
        const chain = loadChain(cwd, name)
        if (!chain) continue
        const active = getActiveNodes(chain)
        for (const node of active) {
          if (count >= maxContextDecisions) break
          sections.push(formatActiveDecision(cwd, name, node))
          count++
        }
      }

      if (sections.length > 0) {
        return {
          appendSystemContext:
            '## 🔮 ocms 当前生效决策\n' + sections.join('\n') + '\n',
        }
      }
    } catch {
      // 注入失败不影响对话
    }
  })

  // ---- agent_end：提取决策/认知/品味（门控写入） ----
  api.on('agent_end', async (event, ctx) => {
    const success = event?.success ?? false
    const cwd = ctx?.workspaceDir

    // 第一版：仅在成功轮次 + 有 workspace 时记录日志占位。
    // 真正的 LLM 门控提取在下一步迭代实现。
    if (!success || !cwd) return

    try {
      setToolCwd(cwd)
      api.logger?.debug?.(`ocms agent_end: extraction hook fired (runId=${ctx?.runId})`)
    } catch {
      /* ignore */
    }
  })
}
