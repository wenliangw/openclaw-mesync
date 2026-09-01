// store/decision — 决策正文（Markdown）读写

import * as fs from 'node:fs'
import * as path from 'node:path'
import { resolveChainDir } from './paths.js'

export interface DecisionContent {
  decision: string
  trigger?: string | null
  rationale: string
  alternatives?: Array<{ option: string; why_not: string }>
  taste_signals?: Array<{ signal: string; context: string }>
}

/** 将决策内容格式化为 Markdown */
export function formatDecisionMarkdown(c: DecisionContent): string {
  const parts: string[] = []
  parts.push(`# 决策：${c.decision}`)
  parts.push('')
  if (c.trigger) {
    parts.push(`- 触发：${c.trigger}`)
    parts.push('')
  }
  parts.push('## 理由（rationale）')
  parts.push('')
  parts.push(c.rationale)
  parts.push('')
  if (c.alternatives?.length) {
    parts.push('## 备选方案（alternatives）')
    parts.push('')
    for (const a of c.alternatives) {
      parts.push(`- ${a.option}（为何不选：${a.why_not}）`)
    }
    parts.push('')
  }
  if (c.taste_signals?.length) {
    parts.push('## 品味信号（taste_signals）')
    parts.push('')
    for (const t of c.taste_signals) {
      parts.push(`- ${t.signal}：${t.context}`)
    }
    parts.push('')
  }
  return parts.join('\n')
}

/** 写决策正文到链文件夹 */
export function writeDecisionMarkdown(
  cwd: string,
  chainName: string,
  fileName: string,
  content: DecisionContent,
): string {
  const dir = resolveChainDir(cwd, chainName)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, fileName)
  fs.writeFileSync(file, formatDecisionMarkdown(content), 'utf-8')
  return file
}

/** 读决策正文 */
export function readDecisionMarkdown(cwd: string, chainName: string, fileName: string): string {
  const file = path.join(resolveChainDir(cwd, chainName), fileName)
  if (!fs.existsSync(file)) return ''
  return fs.readFileSync(file, 'utf-8')
}
