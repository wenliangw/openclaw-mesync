// store/templates — ocms 模板管理
//
// 复用 dsh-mesync 的模板机制：
// - 插件内置 templates/（rules/ + skills/ 下的 md）
// - 首次初始化：目标文件不存在则复制到 agent 的 .ocms/（尊重用户版本，不覆盖）
// - 总纲始终注入，其余按需 read

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as url from 'node:url'
import { resolveDataDir } from './paths.js'

// ---- .ocms 目录下的文件路径常量 ----
export const STRATEGY_SKILL_FILE = '.ocms/skills/_sync_strategy.skill.md'
export const DECISION_RULE_FILE = '.ocms/rules/_sync_decision.rule.md'
export const DECISION_SKILL_FILE = '.ocms/skills/_sync_decision.skill.md'
export const TASTE_SKILL_FILE = '.ocms/skills/_sync_taste.skill.md'
export const COGNITION_SKILL_FILE = '.ocms/skills/_sync_cognition.skill.md'
export const EVENT_RULE_FILE = '.ocms/rules/_sync_event.rule.md'
export const EVENT_SKILL_FILE = '.ocms/skills/_sync_event.skill.md'

/** 内置模板目录（dist/templates/） */
function templateDir(): string {
  const here = path.dirname(url.fileURLToPath(import.meta.url))
  return path.join(here, '..', 'templates')
}

function readTemplate(relPath: string): string {
  try {
    return fs.readFileSync(path.join(templateDir(), relPath), 'utf-8')
  } catch {
    return ''
  }
}

/** 首次初始化：目标文件不存在才复制（尊重用户版本） */
function ensureTemplateFile(agentDir: string, relPath: string, templateRelPath: string): void {
  const target = path.join(agentDir, relPath)
  if (fs.existsSync(target)) return

  const template = readTemplate(templateRelPath)
  if (!template) return

  const dir = path.dirname(target)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(target, template, 'utf-8')
}

/** 读取文件内容：优先读用户版本，否则读内置模板 */
function loadTemplate(agentDir: string, relPath: string, templateRelPath: string): string {
  const target = path.join(agentDir, relPath)
  try {
    if (fs.existsSync(target)) {
      const content = fs.readFileSync(target, 'utf-8')
      if (content.trim()) return content
    }
  } catch {
    /* ignore */
  }
  return readTemplate(templateRelPath)
}

/** 首次初始化所有模板文件到 agent 的 .ocms/ */
export function ensureTemplates(agentDir: string): void {
  ensureTemplateFile(agentDir, STRATEGY_SKILL_FILE, 'skills/_sync_strategy.skill.md')
  ensureTemplateFile(agentDir, DECISION_RULE_FILE, 'rules/_sync_decision.rule.md')
  ensureTemplateFile(agentDir, DECISION_SKILL_FILE, 'skills/_sync_decision.skill.md')
  ensureTemplateFile(agentDir, TASTE_SKILL_FILE, 'skills/_sync_taste.skill.md')
  ensureTemplateFile(agentDir, COGNITION_SKILL_FILE, 'skills/_sync_cognition.skill.md')
  ensureTemplateFile(agentDir, EVENT_RULE_FILE, 'rules/_sync_event.rule.md')
  ensureTemplateFile(agentDir, EVENT_SKILL_FILE, 'skills/_sync_event.skill.md')
}

/** 读取总纲（始终注入的内容） */
export function loadStrategySkill(agentDir: string): string {
  return loadTemplate(agentDir, STRATEGY_SKILL_FILE, 'skills/_sync_strategy.skill.md')
}

/** 确保数据目录结构存在 */
export function ensureDataDirs(agentDir: string): void {
  const dataDir = resolveDataDir(agentDir)
  for (const sub of ['decisions', 'cognition', 'taste', 'events', 'skills', 'rules']) {
    const d = path.join(dataDir, sub)
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true })
  }
}
