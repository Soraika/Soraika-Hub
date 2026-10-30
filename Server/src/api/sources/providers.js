/**
 * AI 供应商目录 —— **取自社区维护的 models.dev**，不在代码里手写
 * ---------------------------------------------------------------------------
 * 为什么不自带清单：模型与供应商几个月就换一批（合并、改名、换域名），
 * 手写必然过期；models.dev 由社区持续维护，一次请求拿到 200+ 家 + 各自的模型名。
 *
 * 只收「能直接当 OpenAI 兼容用」的那些：`npm` 是 `@ai-sdk/openai` /
 * `@ai-sdk/openai-compatible`，并且带了 `api`（= base URL）。
 * 其它（anthropic / google / bedrock 这类原生 SDK）走不了 `/chat/completions`，收进来只会让人配错。
 *
 * 缓存 24 小时；取不到就退回代码里的静态清单（`AI_PROVIDERS`）——
 * 界面照常可用，只是没有 200 家那么多可选。
 */
import { AI_PROVIDERS } from '../../lib/settings.js'
import { request } from '../../lib/http-client.js'
import { logger } from '../../lib/logger.js'

const CATALOG_URL = 'https://models.dev/api.json'
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000
/** 每个供应商最多带多少个模型名（够填下拉，别把响应撑爆） */
const MAX_MODELS = 120
/** 只有这两种 npm 包是 OpenAI 兼容协议 */
const OPENAI_COMPAT = /^@ai-sdk\/(openai|openai-compatible)$/

/** @type {{ at: number, value: object|null }} */
let cache = { at: 0, value: null }

const fallback = () => ({
  source: 'builtin',
  fetchedAt: null,
  providers: AI_PROVIDERS.map((p) => ({ id: p.baseUrl, name: p.name, baseUrl: p.baseUrl, doc: '', models: [] })),
})

/**
 * 供应商清单（含各自的模型名）
 * @returns {Promise<{source:'models.dev'|'builtin', fetchedAt:number|null, providers:Array<{id:string,name:string,baseUrl:string,doc:string,models:string[]}>}>}
 */
export async function listProviders({ log = logger } = {}) {
  if (cache.value && Date.now() - cache.at < CATALOG_TTL_MS) return cache.value

  try {
    const raw = await request(CATALOG_URL, {
      expect: 'json',
      timeoutMs: 20000,
      retries: 1,
      tip: 'models.dev 目录',
      headers: { 'User-Agent': 'SoraikaHub/0.1' },
    })

    const providers = Object.entries(raw || {})
      .filter(([, p]) => p?.api && OPENAI_COMPAT.test(String(p?.npm || '')))
      // 个别条目地址是模板变量（如 `${NEON_AI_GATEWAY_BASE_URL}/v1`）—— 直接填不了，跳过
      .filter(([, p]) => /^https?:\/\//.test(String(p.api)))
      .map(([id, p]) => ({
        id,
        name: String(p.name || id),
        baseUrl: String(p.api).replace(/\/+$/, ''),
        doc: String(p.doc || ''),
        models: Object.keys(p.models || {}).slice(0, MAX_MODELS),
      }))
      .sort((a, b) => a.name.localeCompare(b.name))

    if (!providers.length) throw new Error('目录里没有 OpenAI 兼容的供应商')

    const value = { source: 'models.dev', fetchedAt: Date.now(), providers }
    cache = { at: Date.now(), value }
    log.info({ providers: providers.length }, 'ai.providers ok')
    return value
  } catch (err) {
    // 目录站挂了 / 断网：退回静态清单（含上一次成功的结果，如果有）
    log.warn({ err: err?.message || String(err) }, 'ai.providers fail')
    return cache.value || fallback()
  }
}
