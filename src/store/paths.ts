// store/paths — 数据路径解析
//
// 数据落盘根目录：<agentDir>/.ocms/，其中 agentDir = .openclaw/agents/<agent-id>/
// ocms 面向 Agent 本体，不同 agent 的记忆隔离，各落在自己 agent 目录下。

import * as path from 'node:path'

/** 数据根目录：<agentDir>/.ocms */
export function resolveDataDir(agentDir: string): string {
  return path.join(agentDir, '.ocms')
}

/** 决策目录（所有链文件夹的父目录） */
export function resolveDecisionsDir(agentDir: string): string {
  return path.join(resolveDataDir(agentDir), 'decisions')
}

/** 某条链的文件夹 */
export function resolveChainDir(agentDir: string, chainName: string): string {
  return path.join(resolveDecisionsDir(agentDir), chainName)
}

/** 认知目录 */
export function resolveCognitionDir(agentDir: string): string {
  return path.join(resolveDataDir(agentDir), 'cognition')
}

/** 品味目录 */
export function resolveTasteDir(agentDir: string): string {
  return path.join(resolveDataDir(agentDir), 'taste')
}

/** 事件目录 */
export function resolveEventsDir(agentDir: string): string {
  return path.join(resolveDataDir(agentDir), 'events')
}

/** 事件索引文件 */
export function resolveEventsIndexFile(agentDir: string): string {
  return path.join(resolveEventsDir(agentDir), 'index.json')
}
