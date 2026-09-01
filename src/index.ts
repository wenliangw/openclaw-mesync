// index — openclaw-mesync（ocms）插件入口
//
// 面向 Agent 本体的记忆插件：决策（Markdown 内容 + JSON 链拓扑）/ 认知 / 品味三概念。
// 复用 dsh-mesync 已验证的三概念逻辑，增量：决策向量检索（OpenClaw 原生）+ 升维。

import { definePluginEntry, buildJsonPluginConfigSchema } from 'openclaw/plugin-sdk/plugin-entry'
import { buildOcmsToolFactory } from './tools/index.js'
import { registerHooks } from './hooks/index.js'
import { DEFAULT_CONFIG, type OcmsConfig } from './config.js'

export default definePluginEntry({
  id: 'ocms',
  name: 'openclaw-mesync',
  description:
    'mesync 记忆引擎的 OpenClaw 插件：决策/认知/品味三概念 + 决策因果链结构化记忆，面向 Agent 本体。',
  configSchema: buildJsonPluginConfigSchema({
    type: 'object',
    additionalProperties: false,
    properties: {
      maxContextDecisions: {
        type: 'number',
        description: '注入上下文时最多带几条决策（默认 5）。',
      },
    },
  }),
  register(api) {
    // 解析配置（合并默认值）
    const raw = (api.pluginConfig ?? {}) as Partial<OcmsConfig>
    const ocmsConfig: OcmsConfig = {
      maxContextDecisions: raw.maxContextDecisions ?? DEFAULT_CONFIG.maxContextDecisions,
    }

    // 注册工具（factory 形式，从 toolContext 拿 agentDir）
    api.registerTool(buildOcmsToolFactory())

    // 注册 hook：before_prompt_build（初始化 + 注入）+ agent_end（轻量提示）
    registerHooks({ api, ocmsConfig })
  },
})
