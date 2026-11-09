/**
 * AI 路由 —— 既是前端的接口，也是「对外协议」的出口
 * ---------------------------------------------------------------------------
 *   GET  /api/ai/tools               工具清单（MCP `tools/list` 同形状）+ 是否已配置
 *   POST /api/ai/call                统一调用入口（MCP `tools/call` 同形状）
 *   POST /api/ai/classify/tags       便利直连：前端解析标签用它，省一层封装
 *   POST /api/ai/classify/episodes   便利直连：集数/季/纯番名（下载重命名用）
 *
 * 前两条就是「预留 MCP」的落点：包一个 MCP server 只需转发这两个端点，
 * 工具定义不用再写一份，见 Server/docs/MCP.md。
 * 错误照全局约定走 HTTP 状态码 + `{ ok:false, error }`；工具自身的失败不会用 200 假成功。
 */
import { Router } from 'express'
import { writeFileSync, rmSync, existsSync } from 'node:fs'
import { AI_TOOLS, callAiTool } from '../api/ai-tools.js'
import { aiCacheStats, classifyEpisodes, classifyReleaseTags } from '../api/pages/ai.js'
import {
  DEFAULT_FILE,
  OVERRIDE_FILE,
  PROMPT_KEYS,
  promptHashOf,
  promptSet,
  promptSource,
} from '../api/ai/prompts.js'
import { aiProviderInfo, listModels } from '../api/sources/ai.js'
import { listProviders } from '../api/sources/providers.js'
import { fail } from '../lib/errors.js'

export const aiRouter = Router()

/** body 里的 titles：必须是字符串数组（具体内容校验交给能力层） */
function titlesOf(body) {
  if (!Array.isArray(body?.titles)) throw fail('BAD_REQUEST', 'titles 需要是字符串数组')
  return body.titles
}

/** GET /api/ai/tools —— tools/list 形状；enabled=false 时前端显示「未配置」而不是报错 */
aiRouter.get('/ai/tools', (req, res) => {
  const info = aiProviderInfo()
  res.json({
    ok: true,
    data: {
      enabled: info.enabled,
      model: info.model,
      // 没配 key 时不暴露 baseUrl（没必要，也少一处信息面）
      baseUrl: info.enabled ? info.baseUrl : '',
      maxTitles: info.maxTitles,
      concurrency: info.concurrency,
      tools: AI_TOOLS,
      caches: aiCacheStats(),
    },
  })
})

/**
 * GET /api/ai/prompts —— 当前生效的提示词（含来源与内容 hash）
 * ---------------------------------------------------------------------------
 * 提示词是数据（api/ai/prompts.json 出厂 + data/prompts.json 覆盖），
 * 所以这里只读不写死。返回答：
 *   { source, keys[], prompts: { key: { version, system, hash } } }
 * source 会说明现在是出厂默认、还是读到了覆盖文件（覆盖文件写坏了也写在这里）。
 */
aiRouter.get('/ai/prompts', (req, res) => {
  const prompts = promptSet()
  res.json({
    ok: true,
    data: {
      source: promptSource(),
      overridable: true,
      overrideFile: 'data/prompts.json',
      defaultFile: 'src/api/ai/prompts.json',
      keys: PROMPT_KEYS,
      prompts: Object.fromEntries(
        PROMPT_KEYS.map((key) => [
          key,
          { version: prompts[key]?.version ?? '', hash: promptHashOf(key), system: prompts[key]?.system ?? '' },
        ]),
      ),
    },
  })
})

/**
 * PUT /api/ai/prompts —— 写覆盖文件（不用改源码、不用重启，按 mtime 热加载）
 * ---------------------------------------------------------------------------
 * body：{ prompts: { bundle: { system, version? }, ... } }
 *   · 只写想改的段即可，其余继续用出厂默认（逐段浅合并）
 *   · prompts: null 表示删掉覆盖文件，整份回退出厂默认
 * 校验只做能救命的：段名合法、system 非空且长度不小于 20。空 prompt 会把结果和缓存
 * 一起污染，这种错误必须当场拦住（比事后排查一堆废话便宜得多）。
 */
aiRouter.put('/ai/prompts', (req, res, next) => {
  try {
    const body = req.body || {}
    if (body.prompts === null) {
      if (existsSync(OVERRIDE_FILE)) rmSync(OVERRIDE_FILE, { force: true })
      req.log.info('ai.prompts reset')
      return res.json({ ok: true, data: { source: promptSource(), keys: PROMPT_KEYS } })
    }

    const incoming = body.prompts
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
      throw fail('BAD_REQUEST', 'body 需要是 { prompts: { bundle: { system } } }（传 null 表示恢复默认）')
    }
    const clean = {}
    for (const [key, value] of Object.entries(incoming)) {
      if (!PROMPT_KEYS.includes(key)) throw fail('BAD_REQUEST', `未知的提示词段 ${key}（可用：${PROMPT_KEYS.join(' / ')}）`)
      const system = String(value?.system ?? '').trim()
      if (system.length < 20) throw fail('BAD_REQUEST', `${key}.system 太短（至少要能说清任务；空 prompt 会污染缓存）`)
      clean[key] = { system, ...(value?.version ? { version: String(value.version) } : {}) }
    }
    if (!Object.keys(clean).length) throw fail('BAD_REQUEST', 'prompts 是空的，没什么可保存')

    writeFileSync(OVERRIDE_FILE, `${JSON.stringify(clean, null, 2)}\n`, 'utf8')
    req.log.info({ keys: Object.keys(clean) }, 'ai.prompts update ok')
    res.json({
      ok: true,
      data: { source: promptSource(), keys: PROMPT_KEYS, updated: Object.keys(clean) },
    })
  } catch (err) {
    next(err)
  }
})

/**
 * GET /api/ai/providers —— 供应商目录（社区维护的 models.dev，取不到退回内置清单）
 * 带各自的模型名：还没填 Key 时界面也能先把候选列出来
 */
aiRouter.get('/ai/providers', async (req, res, next) => {
  try {
    const data = await listProviders({ log: req.log })
    res.json({ ok: true, data })
  } catch (err) {
    next(err)
  }
})

/**
 * `?baseUrl=` 可传**还没保存**的地址（换供应商时立刻看那家的模型）
 * 未配置 AI → 501 AI_DISABLED；上游取不到 → 502 UPSTREAM（前端回落成纯手动输入）
 */
aiRouter.get('/ai/models', async (req, res, next) => {
  try {
    const baseUrl = typeof req.query.baseUrl === 'string' ? req.query.baseUrl.trim() : ''
    res.json({ ok: true, data: { models: await listModels({ baseUrl, log: req.log }) } })
  } catch (err) {
    next(err)
  }
})

/**
 * POST /api/ai/call —— MCP tools/call 形状
 * body: `{ name: 'anime_release_tags', arguments: { titles: [...] } }`
 * 返回：`{ content: [{ type:'text', text:<JSON> }], structured: {...}, isError: false }`
 */
aiRouter.post('/ai/call', async (req, res, next) => {
  try {
    const { name, arguments: toolArgs } = req.body || {}
    if (!name) throw fail('BAD_REQUEST', '缺少工具名 name（清单见 GET /api/ai/tools）')

    const result = await callAiTool(String(name), toolArgs || {}, { log: req.log })
    res.json({
      ok: true,
      data: {
        name,
        isError: false,
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structured: result,
      },
    })
  } catch (err) {
    next(err)
  }
})

/** POST /api/ai/classify/tags —— 便利直连（等价于 call name=anime_release_tags） */
aiRouter.post('/ai/classify/tags', async (req, res, next) => {
  try {
    res.json({
      ok: true,
      data: await classifyReleaseTags(titlesOf(req.body), {
        log: req.log,
        animeTitle: String(req.body?.animeTitle || ''),
        season: req.body?.season ?? '',
      }),
    })
  } catch (err) {
    next(err)
  }
})

/** POST /api/ai/classify/episodes —— 便利直连，body: { title, titles } */
aiRouter.post('/ai/classify/episodes', async (req, res, next) => {
  try {
    res.json({ ok: true, data: await classifyEpisodes(req.body?.title, titlesOf(req.body), {
      log: req.log,
      season: req.body?.season ?? '',
    }) })
  } catch (err) {
    next(err)
  }
})
