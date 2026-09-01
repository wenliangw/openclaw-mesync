// test/chain.test.ts — 决策链表逻辑测试（ocms 核心）
//
// 验证 chain.json 读写 + 链表操作：
// - 追加节点（追加式，不覆盖历史）
// - supersedes / superseded_by 指针
// - 当前生效决策过滤
// - 因果链遍历

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  createChain,
  loadChain,
  appendNode,
  getActiveNodes,
  listChains,
  traceCausalChain,
} from '../src/store/chain.js'
import { writeDecisionMarkdown, readDecisionMarkdown } from '../src/store/decision.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocms-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('决策链表（chain.json）', () => {
  it('新建链并追加节点', () => {
    const chain = createChain(tmpDir, 'api-design')
    expect(chain.chainId).toBe('api-design')
    expect(chain.nodes).toHaveLength(0)

    const c = appendNode(tmpDir, 'api-design', {
      id: 'dec-1',
      markdown: 'dec-1.md',
      created_at: new Date().toISOString(),
      outcome: 'adopted',
      caused_by: [],
      supersedes: [],
      scopes: [],
    })

    expect(c.nodes).toHaveLength(1)
    expect(c.nodes[0].id).toBe('dec-1')
    expect(c.nodes[0].superseded_by).toBeNull()
  })

  it('追加式：新决策取代旧决策，旧决策被标记 superseded', () => {
    createChain(tmpDir, 'api-design')
    appendNode(tmpDir, 'api-design', {
      id: 'dec-1',
      markdown: 'dec-1.md',
      created_at: '2026-09-01T10:00:00+08:00',
      outcome: 'adopted',
      caused_by: [],
      supersedes: [],
      scopes: [],
    })

    // dec-2 取代 dec-1
    const chain = appendNode(
      tmpDir,
      'api-design',
      {
        id: 'dec-2',
        markdown: 'dec-2.md',
        created_at: '2026-09-01T11:00:00+08:00',
        outcome: 'adopted',
        caused_by: ['dec-1'],
        supersedes: [],
        scopes: [],
      },
      ['dec-1'],
    )

    const dec1 = chain.nodes.find((n) => n.id === 'dec-1')!
    const dec2 = chain.nodes.find((n) => n.id === 'dec-2')!

    expect(dec1.outcome).toBe('superseded')
    expect(dec1.superseded_by).toBe('dec-2')
    expect(dec2.supersedes).toEqual(['dec-1'])
  })

  it('getActiveNodes 只返回当前生效的决策', () => {
    createChain(tmpDir, 'api-design')
    appendNode(tmpDir, 'api-design', {
      id: 'dec-1',
      markdown: 'dec-1.md',
      created_at: new Date().toISOString(),
      outcome: 'adopted',
      caused_by: [],
      supersedes: [],
      scopes: [],
    })
    appendNode(
      tmpDir,
      'api-design',
      {
        id: 'dec-2',
        markdown: 'dec-2.md',
        created_at: new Date().toISOString(),
        outcome: 'adopted',
        caused_by: ['dec-1'],
        supersedes: [],
        scopes: [],
      },
      ['dec-1'],
    )

    const chain = loadChain(tmpDir, 'api-design')!
    const active = getActiveNodes(chain)

    expect(active).toHaveLength(1)
    expect(active[0].id).toBe('dec-2')
  })

  it('traceCausalChain 沿 caused_by 向上遍历因果链', () => {
    createChain(tmpDir, 'api-design')
    appendNode(tmpDir, 'api-design', {
      id: 'root',
      markdown: 'root.md',
      created_at: new Date().toISOString(),
      outcome: 'superseded',
      caused_by: [],
      supersedes: [],
      scopes: [],
    })
    appendNode(tmpDir, 'api-design', {
      id: 'mid',
      markdown: 'mid.md',
      created_at: new Date().toISOString(),
      outcome: 'superseded',
      caused_by: ['root'],
      supersedes: ['root'],
      scopes: [],
    })
    appendNode(
      tmpDir,
      'api-design',
      {
        id: 'leaf',
        markdown: 'leaf.md',
        created_at: new Date().toISOString(),
        outcome: 'adopted',
        caused_by: ['mid'],
        supersedes: [],
        scopes: [],
      },
      ['mid'],
    )

    const chain = loadChain(tmpDir, 'api-design')!
    const path = traceCausalChain(chain, 'leaf')

    expect(path.map((n) => n.id)).toEqual(['root', 'mid', 'leaf'])
  })

  it('listChains 列出所有链文件夹', () => {
    createChain(tmpDir, 'api-design')
    createChain(tmpDir, 'architecture')

    const chains = listChains(tmpDir)
    expect(chains.sort()).toEqual(['api-design', 'architecture'])
  })
})

describe('决策正文（Markdown）', () => {
  it('写入并读取决策 markdown', () => {
    writeDecisionMarkdown(tmpDir, 'api-design', 'dec-1.md', {
      decision: 'API 设计采用 RESTful',
      rationale: '简单且生态成熟',
      alternatives: [{ option: 'GraphQL', why_not: '复杂度高，团队不熟悉' }],
    })

    const md = readDecisionMarkdown(tmpDir, 'api-design', 'dec-1.md')
    expect(md).toContain('# 决策：API 设计采用 RESTful')
    expect(md).toContain('理由（rationale）')
    expect(md).toContain('GraphQL')
  })
})
