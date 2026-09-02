// test/event.test.ts — 事件层逻辑测试（ocms 对话连续性）
//
// 验证事件状态机 + 关系 + 嵌套分组 + 向量检索 + 指针：
// - 四态状态机（open/asked/closed/dormant）
// - 追加式 upsert（不覆盖历史，更新可变字段）
// - 父子嵌套（大话题分组）
// - 关系（produced_decisions / influences）
// - 进行中事件过滤（open/asked）
// - 向量检索（余弦相似度排序）
// - 指针（source_refs）读写

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  upsertEvent,
  loadEventIndex,
  findEvent,
  setEventStatus,
  listOpenEvents,
  searchEventsByVector,
  updateEventEmbedding,
} from '../src/store/event.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocms-event-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function mkEvent(id: string, title: string, status: any = 'open') {
  return upsertEvent(tmpDir, {
    id,
    markdown: `${id}.md`,
    title,
    summary: `摘要：${title}`,
    status,
    parent: null,
    produced_decisions: [],
    influences: [],
    source_refs: [],
  })
}

describe('事件状态机', () => {
  it('新建事件默认可指定状态', () => {
    const e = mkEvent('evt-1', '讨论 ocms 对话记忆', 'open')
    expect(e.id).toBe('evt-1')
    expect(e.status).toBe('open')
    expect(e.created_at).toBeTruthy()
  })

  it('状态流转：open → asked → closed → dormant', () => {
    mkEvent('evt-1', '话题 A', 'open')
    setEventStatus(tmpDir, 'evt-1', 'asked')
    expect(findEvent(loadEventIndex(tmpDir), 'evt-1')!.status).toBe('asked')

    setEventStatus(tmpDir, 'evt-1', 'closed')
    expect(findEvent(loadEventIndex(tmpDir), 'evt-1')!.status).toBe('closed')

    setEventStatus(tmpDir, 'evt-1', 'dormant')
    expect(findEvent(loadEventIndex(tmpDir), 'evt-1')!.status).toBe('dormant')
  })

  it('upsert 是追加式：更新已有事件不覆盖 created_at', async () => {
    const e1 = mkEvent('evt-1', '旧标题', 'open')
    const created = e1.created_at

    // 等待 2ms 确保 updated_at 时间戳不同
    await new Promise((r) => setTimeout(r, 2))

    // 更新标题 + 摘要
    upsertEvent(tmpDir, {
      id: 'evt-1',
      markdown: 'evt-1.md',
      title: '新标题',
      summary: '新摘要',
      status: 'closed',
      parent: null,
      produced_decisions: ['dec-1'],
      influences: ['evt-2'],
      source_refs: [{ file: 'memory/2026-09-01.md', anchor: '## 段落' }],
    })

    const idx = loadEventIndex(tmpDir)
    expect(idx.events).toHaveLength(1) // 不新增，还是 1 个
    const updated = findEvent(idx, 'evt-1')!
    expect(updated.title).toBe('新标题')
    expect(updated.status).toBe('closed')
    expect(updated.created_at).toBe(created) // created_at 不变
    expect(updated.updated_at).not.toBe(created)
    expect(updated.produced_decisions).toEqual(['dec-1'])
    expect(updated.influences).toEqual(['evt-2'])
    expect(updated.source_refs).toHaveLength(1)
  })
})

describe('事件嵌套分组（大话题含小事件）', () => {
  it('子事件挂到父事件，父事件 children 冗余指针自动维护', () => {
    mkEvent('parent-1', '大话题', 'open')
    upsertEvent(tmpDir, {
      id: 'child-1',
      markdown: 'child-1.md',
      title: '小话题 1',
      summary: '...',
      status: 'open',
      parent: 'parent-1',
      produced_decisions: [],
      influences: [],
      source_refs: [],
    })

    const idx = loadEventIndex(tmpDir)
    const parent = findEvent(idx, 'parent-1')!
    const child = findEvent(idx, 'child-1')!

    expect(parent.children).toContain('child-1')
    expect(child.parent).toBe('parent-1')
  })
})

describe('进行中事件过滤（对话连续性）', () => {
  it('只返回 open 和 asked 状态，按更新时间倒序', () => {
    mkEvent('evt-1', '话题 A', 'open')
    mkEvent('evt-2', '话题 B', 'closed')
    mkEvent('evt-3', '话题 C', 'asked')
    mkEvent('evt-4', '话题 D', 'dormant')

    const open = listOpenEvents(loadEventIndex(tmpDir))
    const ids = open.map((e) => e.id).sort()
    expect(ids).toEqual(['evt-1', 'evt-3'])
  })
})

describe('事件向量检索', () => {
  it('余弦相似度排序 + 无 embedding 的事件被过滤', () => {
    const idx = loadEventIndex(tmpDir)
    mkEvent('evt-1', '事件一', 'closed')
    mkEvent('evt-2', '事件二', 'closed')
    mkEvent('evt-3', '事件三', 'closed')

    // 手动构造 embedding
    updateEventEmbedding(tmpDir, 'evt-1', [1, 0, 0])
    updateEventEmbedding(tmpDir, 'evt-2', [0, 1, 0])
    // evt-3 不设 embedding

    const idx2 = loadEventIndex(tmpDir)
    const results = searchEventsByVector(idx2, [1, 0, 0], 5)
    expect(results).toHaveLength(2) // evt-3 无 embedding 被过滤
    expect(results[0].event.id).toBe('evt-1') // 最相似
    expect(results[0].score).toBeCloseTo(1.0, 5)
  })
})

describe('事件指针（source_refs）', () => {
  it('指针读写：file + anchor', () => {
    upsertEvent(tmpDir, {
      id: 'evt-1',
      markdown: 'evt-1.md',
      title: '话题',
      summary: '...',
      status: 'closed',
      parent: null,
      produced_decisions: [],
      influences: [],
      source_refs: [{ file: 'memory/2026-09-01.md', anchor: '## ocms 对话记忆', confidence: 'high' }],
    })

    const e = findEvent(loadEventIndex(tmpDir), 'evt-1')!
    expect(e.source_refs[0].file).toBe('memory/2026-09-01.md')
    expect(e.source_refs[0].anchor).toBe('## ocms 对话记忆')
  })
})
