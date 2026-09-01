// store/chain — chain.json 读写 + 决策链表操作
//
// 一条链 = 一个文件夹。chain.json 记录这条链的拓扑（JSON 数组，链表结构）。
// 决策正文存 decision-<id>.md，chain.json 只存指针 + 结构字段。

import * as fs from 'node:fs'
import * as path from 'node:path'
import { resolveChainDir, resolveDecisionsDir } from './paths.js'

// ---- 类型 ----

export type DecisionOutcome = 'adopted' | 'superseded' | 'refined' | 'pending'

export interface ChainNode {
  id: string
  markdown: string
  created_at: string
  outcome: DecisionOutcome
  caused_by: string[]
  supersedes: string[]
  superseded_by: string | null
  scopes: string[]
  /** 决策向量（浮点数组），用于向量检索。未生成时为 null。 */
  embedding?: number[] | null
}

export interface Chain {
  chainId: string
  nodes: ChainNode[]
}

// ---- 读写 ----

export function loadChain(agentDir: string, chainName: string): Chain | null {
  const file = path.join(resolveChainDir(agentDir, chainName), 'chain.json')
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as Chain
  } catch {
    return null
  }
}

export function saveChain(agentDir: string, chain: Chain): void {
  const dir = resolveChainDir(agentDir, chain.chainId)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'chain.json')
  fs.writeFileSync(file, JSON.stringify(chain, null, 2), 'utf-8')
}

// ---- 链表操作 ----

/** 新建一条空链 */
export function createChain(agentDir: string, chainId: string): Chain {
  const chain: Chain = { chainId, nodes: [] }
  saveChain(agentDir, chain)
  return chain
}

/**
 * 追加一个决策节点到链尾。
 * 追加式：新节点 supersedes 指向被取代的旧节点，旧节点 superseded_by 指向新节点。
 */
export function appendNode(
  agentDir: string,
  chainName: string,
  node: Omit<ChainNode, 'superseded_by'> & { superseded_by?: string | null },
  supersedeIds: string[] = [],
): Chain {
  const chain = loadChain(agentDir, chainName) ?? createChain(agentDir, chainName)

  // 新节点
  const newNode: ChainNode = {
    ...node,
    supersedes: supersedeIds,
    superseded_by: null,
    caused_by: node.caused_by ?? [],
  }

  // 更新被取代节点的 superseded_by 指针
  for (const id of supersedeIds) {
    const target = chain.nodes.find((n) => n.id === id)
    if (target) {
      target.superseded_by = newNode.id
      if (target.outcome === 'adopted') target.outcome = 'superseded'
    }
  }

  chain.nodes.push(newNode)
  saveChain(agentDir, chain)
  return chain
}

/** 取链上所有「当前生效」的节点（superseded_by = null 且 adopted） */
export function getActiveNodes(chain: Chain): ChainNode[] {
  return chain.nodes.filter((n) => n.superseded_by === null && n.outcome === 'adopted')
}

/** 按 id 找节点 */
export function findNode(chain: Chain, id: string): ChainNode | null {
  return chain.nodes.find((n) => n.id === id) ?? null
}

/** 沿 caused_by 向上遍历因果链，返回从根到目标节点的路径 */
export function traceCausalChain(chain: Chain, nodeId: string): ChainNode[] {
  const result: ChainNode[] = []
  const visited = new Set<string>()
  const walk = (id: string) => {
    if (visited.has(id)) return
    visited.add(id)
    const node = findNode(chain, id)
    if (!node) return
    for (const parentId of node.caused_by) walk(parentId)
    result.push(node)
  }
  walk(nodeId)
  return result
}

/** 更新某个节点的 embedding 向量 */
export function updateNodeEmbedding(
  agentDir: string,
  chainName: string,
  nodeId: string,
  embedding: number[],
): void {
  const chain = loadChain(agentDir, chainName)
  if (!chain) return
  const node = chain.nodes.find((n) => n.id === nodeId)
  if (!node) return
  node.embedding = embedding
  saveChain(agentDir, chain)
}

/** 余弦相似度 */
export function cosineSimilarity(a: number[], b: number[]): number {
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

/**
 * 向量检索：对当前生效的决策做余弦相似度排序。
 * 只在当前生效决策（superseded_by = null）里检索，天然隐藏被取代的旧决策。
 */
export function searchDecisionsByVector(
  chain: Chain,
  queryVector: number[],
  limit = 5,
): Array<{ node: ChainNode; score: number }> {
  const active = getActiveNodes(chain)
  const scored = active
    .map((node) => {
      if (!node.embedding || node.embedding.length === 0) return { node, score: -1 }
      return { node, score: cosineSimilarity(queryVector, node.embedding) }
    })
    .filter((r) => r.score >= 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
  return scored
}

/** 列出 decisions 目录下所有链（文件夹名） */
export function listChains(agentDir: string): string[] {
  const dir = resolveDecisionsDir(agentDir)
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
}
