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
import { upstreamCache } from './../../cache/mem.js'
import { config } from './../../config.js'
import { fail } from './../../lib/errors.js'
import { request } from './../../lib/http-client.js'
import { logger } from './../../lib/logger.js'

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
/**
 * 默认供应商 = `config.ai` —— 不传 provider 时就走它（与以前的行为完全一致）
 * 想换供应商 / 换模型时，由调用方传一份**快照**覆盖（见下面 chatJson 的说明）。
 */
const defaultProvider = () => ({
  baseUrl: config.ai.baseUrl,
  apiKey: config.ai.apiKey,
  model: config.ai.model,
  timeoutMs: config.ai.timeoutMs,
  maxTokens: config.ai.maxTokens,
  enabled: config.ai.enabled,
  /** 供应商特有参数：原样并入请求体。默认关掉 DeepSeek 的思考模式（很慢，解析类任务用不上） */
  params: { thinking: { type: 'disabled' } },
})

/**
 * 一次对话，返回解析好的 JSON
 * @param {{ system:string, user:string, maxTokens?:number, provider?:object, log?:object }} options
 *   `provider` 是**一次调用所需的全部供应商参数（快照）**：
 *   `{ baseUrl, apiKey, model, timeoutMs, maxTokens, enabled, params }`；不传就用 `config.ai`。
 *   为什么是快照而不是 config 本身：避免调用中途设置被改；
 *   而且以后「多提供商 / 按用途选模型 / 用户自定义提示词」只改「谁来提供这个对象」，
 *   调用点一行都不用动（见 CONVENTIONS.md §9）。
 * @returns {Promise<{ parsed: any, model: string, ms: number, usage: object|null }>}
 */
export async function chatJson({ system, user, maxTokens, provider, log = logger } = {}) {
  const p = { ...defaultProvider(), ...(provider || {}) }
  if (!p.enabled) {
    throw fail('AI_DISABLED', 'AI 未配置：请在设置页填写 API Key（或 Server/.env 的 AI_API_KEY）')
  }

  const startedAt = Date.now()
  const data = await request(`${p.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${p.apiKey}` },
    json: {
      model: p.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      // 解析类任务要的是「同样输入给同样输出」，不是创造力
      temperature: 0.1,
      max_tokens: maxTokens ?? p.maxTokens,
      // 供应商特有参数（默认只有 DeepSeek 的 thinking）—— 不写死在这里，换网关时覆盖 provider.params
      ...p.params,
    },
    timeoutMs: p.timeoutMs,
    retries: 1,
    expect: 'json',
    tip: 'AI chat',
  })

  const content = data?.choices?.[0]?.message?.content || ''
  const parsed = extractJson(content, log)
  const ms = Date.now() - startedAt
  log.debug({ model: data?.model || p.model, chars: content.length, ms }, 'ai.chat ok')

  return { parsed, model: data?.model || p.model, ms, usage: data?.usage ?? null }
}

/** 给路由/看板用的供应商信息（**不含 key**） */
export const aiProviderInfo = () => ({
  enabled: config.ai.enabled,
  model: config.ai.model,
  baseUrl: config.ai.baseUrl,
  /** 单批上限（内部常数，只做可观测性展示） */
  maxTitles: config.ai.maxTitles,
  concurrency: config.ai.concurrency,
})

/**
 * 列出某个 OpenAI 兼容接口可用的模型
 * ---------------------------------------------------------------------------
 * 走 `/models` 端点：模型名会随供应商更新，写死在代码里迟早过期，
 * 所以设置页的模型项做成「可输入 + 可下拉」，下拉项就从这里来。
 * `baseUrl` 可传入**还没保存**的地址 —— 用户在下拉里换供应商时，界面要能立刻拿到那家的模型列表，
 * 而不是等他先保存、再退回来看（`/models` 只需要 key，不需要保存）。
 * 结果按地址缓存（10 分钟）：同一个地址反复点开下拉不会反复请求。
 */
export async function listModels({ baseUrl, log = logger } = {}) {
  if (!config.ai.enabled) {
    throw fail('AI_DISABLED', 'AI 未配置：先在设置页填写 API Key')
  }
  const base = String(baseUrl || config.ai.baseUrl).replace(/\/+$/, '')
  const cacheKey = `ai:models:${base}`
  return upstreamCache.wrap(
    cacheKey,
    async () => {
      const res = await request(`${base}/models`, {
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
      log.info({ baseUrl: base, count: models.length }, 'ai.models ok')
      return models
    },
    MODELS_TTL_MS,
  )
}

/** 模型列表的缓存时长：模型上架/下架不频繁，10 分钟足够 */
const MODELS_TTL_MS = 10 * 60 * 1000
