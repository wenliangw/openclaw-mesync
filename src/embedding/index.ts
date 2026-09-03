// embedding/index — 复用 OpenClaw 的 memory embedding provider
//
// 思路（路线 2）：
// - 探测 OpenClaw 的记忆向量后端插件（memory-lancedb 等）是否已启用
// - 从该插件的 config.embedding 读 provider + model（用户零重复配置）
// - getMemoryEmbeddingProvider(id) 拿 adapter
// - adapter.create({ config, provider, model }) 实例化出 embedQuery/embedBatch
// - key 全部来自 OpenClaw 配置，用户零重复配置
//
// 语义检索是必须能力，向量检索是可选的优化：未启用向量插件时返回 null，
// 调用方退化为「关键词粗筛 + 主 Agent 语义精判」，而不是放弃语义检索。

import type { OpenClawConfig } from 'openclaw/plugin-sdk/plugin-entry'
import {
  getMemoryEmbeddingProvider,
  type MemoryEmbeddingProvider,
} from 'openclaw/plugin-sdk/memory-core-host-engine-embeddings'

let cachedProvider: MemoryEmbeddingProvider | null = null
let cachedKey: string | null = null

/**
 * 从 OpenClaw 配置解析 embedding 的 provider id + model。
 *
 * OpenClaw 的记忆向量后端是「记忆插件」（memory-lancedb 等），通过
 * plugins.slots.memory 选定、plugins.entries[<slot>].config.embedding 配置。
 * 未启用任何向量记忆插件时返回 null（调用方降级）。
 */
function resolveMemorySearch(config: OpenClawConfig): { provider: string; model: string } | null {
  const plugins = (config as any)?.plugins
  if (!plugins) return null

  const slot = plugins?.slots?.memory
  if (!slot || typeof slot !== 'string') return null

  const embedding = plugins?.entries?.[slot]?.config?.embedding
  if (!embedding) return null

  const provider = embedding.provider
  const model = embedding.model
  if (!provider || !model) return null
  return { provider, model }
}

/**
 * 获取（并缓存）memory embedding 实例。
 * 返回 null 表示当前环境没有配置 embedding（调用方需降级）。
 */
export async function getEmbeddingProvider(
  config: OpenClawConfig,
): Promise<MemoryEmbeddingProvider | null> {
  const resolved = resolveMemorySearch(config)
  if (!resolved) return null

  const cacheKey = `${resolved.provider}:${resolved.model}`
  if (cachedProvider && cachedKey === cacheKey) return cachedProvider

  const adapter = getMemoryEmbeddingProvider(resolved.provider, config)
  if (!adapter) return null

  const result = await adapter.create({
    config,
    provider: resolved.provider,
    model: resolved.model,
  })

  if (!result?.provider) return null

  cachedProvider = result.provider
  cachedKey = cacheKey
  return result.provider
}

/** 对一段文本生成查询向量。失败返回 null。 */
export async function embedQuery(
  config: OpenClawConfig,
  text: string,
): Promise<number[] | null> {
  const provider = await getEmbeddingProvider(config)
  if (!provider) return null
  try {
    return await provider.embedQuery(text)
  } catch {
    return null
  }
}

/** 对一段文本生成文档向量。失败返回 null。 */
export async function embedDocument(
  config: OpenClawConfig,
  text: string,
): Promise<number[] | null> {
  const provider = await getEmbeddingProvider(config)
  if (!provider) return null
  try {
    return (await provider.embedBatch([text]))?.[0] ?? null
  } catch {
    return null
  }
}

export function resetEmbeddingCache(): void {
  cachedProvider = null
  cachedKey = null
}
