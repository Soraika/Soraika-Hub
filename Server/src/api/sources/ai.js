/**
 * AI 数据源 —— OpenAI 兼容的 /chat/completions（默认 DeepSeek）
 * ---------------------------------------------------------------------------
 * 与 sources/mikan、sources/bgm 同级：把「问一次模型、拿回一段 JSON」归一化，
 * 上层（api/pages/ai.js）只管业务 prompt，不碰供应商细节。
 * 三件在这里统一处理的事：
 *   1. 没配 key → 抛 AI_DISABLED：这是**已知状态**，不是异常。前端据此显示「未配置」，
 *      而不是给一个点了也没用的「重试」按钮
 *   2. 超时 / 重试 / 退避复用 lib/http-client.js（与抓网页同一套策略）
 *   3. 模型爱把 JSON 包在 ```json 里、或在后面补一句解释 —— 抠 JSON 是这里的活；
 *      抠不出来归 PARSE（与「上游页面改版」同类：重试没用，得改 prompt）
 * 换供应商只改 config.ai 的 baseUrl / model（OpenAI、Moonshot、本地 Ollama、vLLM 都兼容）。
 */
import { upstreamCache } from '../../cache/mem.js'
import { config } from '../../config.js'
import { fail } from '../../lib/errors.js'
import { request } from '../../lib/http-client.js'
import { logger } from '../../lib/logger.js'

/** 从模型回复里抠出 JSON 对象：去掉代码围栏 → 直接解析 → 退一步截取首尾大括号之间 */
function extractJson(content, log) {
  const text = String(content || '')
    .replace(/```json\s*/gi, '')
    .replace(/```/g, '')
    .trim()

  try {
    return JSON.parse(text)
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1))
      } catch {
        /* 落到下面统一报错 */
      }
    }
    // detail 里只放片段：够定位是「模型跑偏」还是「prompt 没说清」就行
    log.warn({ chars: text.length, head: text.slice(0, 160) }, 'ai.chat bad-json')
    throw fail('PARSE', 'AI 返回的不是可解析的 JSON', { head: text.slice(0, 160) })
  }
}

/**
 * 一次对话，返回解析好的 JSON
 * @param {{ system: string, user: string, maxTokens?: number, log?: object }} options
 * @returns {Promise<{ parsed: any, model: string, ms: number, usage: object|null }>}
 */
export async function chatJson({ system, user, maxTokens, log = logger } = {}) {
  if (!config.ai.enabled) {
    throw fail('AI_DISABLED', 'AI 未配置：请在 Server/.env 里填 AI_API_KEY（默认接 DeepSeek 兼容接口）')
  }

  const startedAt = Date.now()
  const data = await request(`${config.ai.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.ai.apiKey}` },
    json: {
      model: config.ai.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      // 解析类任务要的是「同样输入给同样输出」，不是创造力
      temperature: 0.1,
      max_tokens: maxTokens ?? config.ai.maxTokens,
      // DeepSeek 的思考模式很慢，解析文件名用不上；别的网关会忽略这个字段
      thinking: { type: 'disabled' },
    },
    timeoutMs: config.ai.timeoutMs,
    retries: 1,
    expect: 'json',
    tip: 'AI chat',
  })

  const content = data?.choices?.[0]?.message?.content || ''
  const parsed = extractJson(content, log)
  const ms = Date.now() - startedAt
  log.debug({ model: data?.model || config.ai.model, chars: content.length, ms }, 'ai.chat ok')

  return { parsed, model: data?.model || config.ai.model, ms, usage: data?.usage ?? null }
}

/** 给路由/看板用的供应商信息（**不含 key**） */
export const aiProviderInfo = () => ({
  enabled: config.ai.enabled,
  model: config.ai.model,
  baseUrl: config.ai.baseUrl,
  maxTitles: config.ai.maxTitles,
})

/**
 * 列出当前接口可用的模型
 * ---------------------------------------------------------------------------
 * 走 OpenAI 兼容的 `/models` 端点：模型名会随供应商更新，写死在代码里迟早过期，
 * 所以设置页的模型项做成「可输入 + 可下拉」，下拉项就从这里来。
 * 结果按 baseUrl 缓存（10 分钟）：同一个地址反复点开下拉不会反复请求。
 */
export async function listModels({ log = logger } = {}) {
  if (!config.ai.enabled) {
    throw fail('AI_DISABLED', 'AI 未配置：先在设置页填写 API Key')
  }
  const cacheKey = `ai:models:${config.ai.baseUrl}`
  return upstreamCache.wrap(
    cacheKey,
    async () => {
      const res = await request(`${config.ai.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${config.ai.apiKey}` },
        timeoutMs: 10000,
        retries: 0,
        expect: 'json',
        tip: 'AI models',
      })
      const models = (res?.data ?? [])
        .map((item) => (typeof item === 'string' ? item : item?.id))
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b))
      log.info({ baseUrl: config.ai.baseUrl, count: models.length }, 'ai.models ok')
      return models
    },
    MODELS_TTL_MS,
  )
}

/** 模型列表的缓存时长：模型上架/下架不频繁，10 分钟足够 */
const MODELS_TTL_MS = 10 * 60 * 1000
