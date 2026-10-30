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
import { AI_TOOLS, callAiTool } from '../api/ai-tools.js'
import { aiCacheStats, classifyEpisodes, classifyReleaseTags } from '../api/pages/ai.js'
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
      tools: AI_TOOLS,
      caches: aiCacheStats(),
    },
  })
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
    res.json({ ok: true, data: await classifyEpisodes(req.body?.title, titlesOf(req.body), { log: req.log }) })
  } catch (err) {
    next(err)
  }
})
