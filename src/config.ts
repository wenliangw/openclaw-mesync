// config — ocms 插件配置定义

export interface OcmsConfig {
  /** 注入上下文时最多带几条决策（默认 5） */
  maxContextDecisions: number
  /** 启用 ocms 的 agent id 白名单（空数组 = 所有 agent） */
  agents: string[]
}

/** 配置默认值 */
export const DEFAULT_CONFIG: OcmsConfig = {
  maxContextDecisions: 5,
  agents: [],
}

/** 判断某个 agent 是否应启用 ocms（agents 为空 = 全部启用） */
export function isAgentEnabled(agents: string[], agentId: string): boolean {
  if (!agents || agents.length === 0) return true
  return agents.includes(agentId)
}
