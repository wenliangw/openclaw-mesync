// embedding/index — 复用 OpenClaw 的 memory embedding provider
//
// 思路（路线 2）：
// - 读 OpenClaw 配置里的 memorySearch.provider + model
// - getMemoryEmbeddingProvider(id) 拿 adapter
// - adapter.create({ config, provider, model }) 实例化出 embedQuery/embedBatch
// - key 全部来自 OpenClaw 配置，用户零重复配置
//
// 降级：未配置 embedding 时返回 null，调用方退化为关键词匹配。

import type { OpenClawConfig } from 'openclaw/plugin-sdk/plugin-entry'
import {
  getMemoryEmbeddingProvider,
  type MemoryEmbeddingProvider,
} from 'openclaw/plugin-sdk/memory-core-host-engine-embeddings'

let cachedProvider: MemoryEmbeddingProvider | null = null
let cachedKey: string | null = null

/** 从 OpenClaw 配置解析 memorySearch 的 provider id + model */
function resolveMemorySearch(config: OpenClawConfig): { provider: string; model: string } | null {
  const ms = (config as any)?.agents?.defaults?.memorySearch
  if (!ms) return null
  const provider = ms.provider
  const model = ms.model
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
