// store/event — 事件层：index.json 读写 + 状态机 + 关系 + 向量检索
//
// 事件（Event）解决「对话连续性」：跨会话接上之前聊过的话题。
// 事件摘要存 event-<id>.md，结构（状态/层级/关系/指针/embedding）存 index.json。
// 事件不存流水账，只存摘要 + 指向 OpenClaw 原始 memory/*.md 的指针。

import * as fs from 'node:fs'
import * as path from 'node:path'
import { resolveEventsDir, resolveEventsIndexFile } from './paths.js'

// ---- 类型 ----

export type EventStatus = 'open' | 'asked' | 'closed' | 'dormant'

export interface SourceRef {
  /** 原始记录文件，如 memory/2026-09-01.md */
  file: string
  /** 段落标题 / 锚文本（不用行号，抗偏移） */
  anchor: string
  /** 置信度提示 */
  confidence?: string
}

export interface EventRecord {
  id: string
  /** 事件正文文件名（event-<id>.md） */
  markdown: string
  /** 一句话标题（检索摘要字段） */
  title: string
  /** 摘要 */
  summary: string
  /** 状态 */
  status: EventStatus
  /** 父事件 id（大话题分组），null 表示顶层 */
  parent: string | null
  /** 子事件 id 列表（冗余，方便遍历） */
  children: string[]
  created_at: string
  updated_at: string
  /** 产生的决策 id 列表（事件 → 决策「产生自」） */
  produced_decisions: string[]
  /** 影响的事件 id 列表（事件 → 事件「影响」，单向多对多） */
  influences: string[]
  /** 原始记录指针 */
  source_refs: SourceRef[]
  /** 事件向量（浮点数组），用于向量检索，未生成时 null */
  embedding?: number[] | null
}

export interface EventIndex {
  events: EventRecord[]
}

// ---- 读写 ----

export function loadEventIndex(agentDir: string): EventIndex {
  const file = resolveEventsIndexFile(agentDir)
  if (!fs.existsSync(file)) return { events: [] }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
    if (parsed && Array.isArray(parsed.events)) return parsed as EventIndex
    return { events: [] }
  } catch {
    return { events: [] }
  }
}

export function saveEventIndex(agentDir: string, index: EventIndex): void {
  const dir = resolveEventsDir(agentDir)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(resolveEventsIndexFile(agentDir), JSON.stringify(index, null, 2), 'utf-8')
}

// ---- 事件正文 ----

export function readEventMarkdown(agentDir: string, fileName: string): string {
  const file = path.join(resolveEventsDir(agentDir), fileName)
  try {
    return fs.readFileSync(file, 'utf-8')
  } catch {
    return ''
  }
}

export function writeEventMarkdown(agentDir: string, fileName: string, content: string): void {
  const dir = resolveEventsDir(agentDir)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, fileName), content, 'utf-8')
}

// ---- 事件操作 ----

export function findEvent(index: EventIndex, id: string): EventRecord | null {
  return index.events.find((e) => e.id === id) ?? null
}

/**
 * 新建或更新事件。
 * 追加式：新事件追加，更新已有事件时只改可变字段（title/summary/status/关系/指针）。
 */
export function upsertEvent(
  agentDir: string,
  record: Omit<EventRecord, 'children' | 'created_at' | 'updated_at'> & { children?: string[] },
): EventRecord {
  const index = loadEventIndex(agentDir)
  const existing = findEvent(index, record.id)
  const now = new Date().toISOString()

  if (existing) {
    // 更新可变字段
    existing.title = record.title
    existing.summary = record.summary
    existing.status = record.status
    existing.parent = record.parent
    if (record.children) existing.children = record.children
    existing.produced_decisions = record.produced_decisions
    existing.influences = record.influences
    existing.source_refs = record.source_refs
    if (record.embedding) existing.embedding = record.embedding
    existing.updated_at = now
    saveEventIndex(agentDir, index)
    return existing
  }

  const newEvent: EventRecord = {
    ...record,
    children: record.children ?? [],
    created_at: now,
    updated_at: now,
  }
  index.events.push(newEvent)

  // 维护父事件的 children 冗余指针
  if (record.parent) {
    const parent = findEvent(index, record.parent)
    if (parent && !parent.children.includes(newEvent.id)) {
      parent.children.push(newEvent.id)
    }
  }

  saveEventIndex(agentDir, index)
  return newEvent
}

/** 更新事件状态（状态机流转入口） */
export function setEventStatus(agentDir: string, id: string, status: EventStatus): EventRecord | null {
  const index = loadEventIndex(agentDir)
  const event = findEvent(index, id)
  if (!event) return null
  event.status = status
  event.updated_at = new Date().toISOString()
  saveEventIndex(agentDir, index)
  return event
}

/** 列出「进行中」事件（open 或 asked）—— 对话连续性注入 + 唤起未完成话题 */
export function listOpenEvents(index: EventIndex): EventRecord[] {
  return index.events
    .filter((e) => e.status === 'open' || e.status === 'asked')
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
}

// ---- 向量检索 ----

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** 向量检索事件：对所有事件（不限状态）做余弦排序，用于唤起沉底的历史事件 */
export function searchEventsByVector(
  index: EventIndex,
  queryVector: number[],
  limit = 5,
): Array<{ event: EventRecord; score: number }> {
  return index.events
    .map((event) => {
      if (!event.embedding || event.embedding.length === 0) return { event, score: -1 }
      return { event, score: cosineSimilarity(queryVector, event.embedding) }
    })
    .filter((r) => r.score >= 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

/** 更新事件 embedding */
export function updateEventEmbedding(agentDir: string, id: string, embedding: number[]): void {
  const index = loadEventIndex(agentDir)
  const event = findEvent(index, id)
  if (!event) return
  event.embedding = embedding
  event.updated_at = new Date().toISOString()
  saveEventIndex(agentDir, index)
}
