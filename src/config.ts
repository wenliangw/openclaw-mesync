// config — ocms 插件配置定义

export interface OcmsConfig {
  /** 注入上下文时最多带几条决策（默认 5） */
  maxContextDecisions: number
}

/** 配置默认值 */
export const DEFAULT_CONFIG: OcmsConfig = {
  maxContextDecisions: 5,
}
