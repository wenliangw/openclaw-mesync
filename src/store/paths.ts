// store/paths — 数据路径解析
// 数据落盘根目录：<cwd>/.openclaw/.ocms/

import * as path from 'node:path'

/** 数据根目录 */
export function resolveDataDir(cwd: string): string {
  return path.join(cwd, '.openclaw', '.ocms')
}

/** 决策目录（所有链文件夹的父目录） */
export function resolveDecisionsDir(cwd: string): string {
  return path.join(resolveDataDir(cwd), 'decisions')
}

/** 某条链的文件夹 */
export function resolveChainDir(cwd: string, chainName: string): string {
  return path.join(resolveDecisionsDir(cwd), chainName)
}

/** 认知目录 */
export function resolveCognitionDir(cwd: string): string {
  return path.join(resolveDataDir(cwd), 'cognition')
}

/** 品味目录 */
export function resolveTasteDir(cwd: string): string {
  return path.join(resolveDataDir(cwd), 'taste')
}
