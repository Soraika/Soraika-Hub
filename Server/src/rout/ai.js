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
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { AI_TOOLS, callAiTool } from '../api/ai-tools.js'
import { aiCacheStats, classifyEpisodes, classifyReleaseTags } from '../api/pages/ai.js'
import {
  DEFAULT_FILE,
  OVERRIDE_FILE,
  PROMPT_KEYS,
  customizedKeys,
  defaultPrompts,
  promptCustomOf,
  promptHashOf,
  promptSource,
  promptSystemOf,
  promptText,
  promptVersion,
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
  const defaults = defaultPrompts()
  res.json({
    ok: true,
    data: {
      source: promptSource(),
      overridable: true,
      overrideFile: 'data/prompts.json',
      defaultFile: 'src/api/ai/prompts.json',
      keys: PROMPT_KEYS,
      /** 哪几段和出厂默认不一样（系统段或自定义段任一不同） */
      customized: customizedKeys(),
      /**
       * 每段拆成三份给界面：
       *   system    我们的要求（只读，改坏就回不出可用结构）
       *   custom    用户补充（可编辑）
       *   effective 实际发给模型的正文（system + custom），给人看最终效果
       */
      prompts: Object.fromEntries(
        PROMPT_KEYS.map((key) => [
          key,
          {
            version: promptVersion(key),
            hash: promptHashOf(key),
            system: promptSystemOf(key),
            custom: promptCustomOf(key),
            effective: promptText(key),
          },
        ]),
      ),
      /** 出厂默认的系统段：恢复默认时系统段回到这里、自定义段清空 */
      defaults: Object.fromEntries(PROMPT_KEYS.map((key) => [key, defaults[key]?.system ?? ''])),
    },
  })
})

/**
 * 提示词的「输出契约」：每段提示词必须保留哪些字段名
 * ---------------------------------------------------------------------------
 * 模型输出能不能用，取决于提示词里有没有把 JSON 结构写清楚。用户改措辞时最容易
 * 顺手把结构说明删掉（或改成散文），结果模型返回一堆解释文字，解析层只能报 PARSE，
 * 而现象是「标签突然全没了」，很难联想到是提示词改坏的。
 * 所以保存时做一次字面检查：缺了关键字段名就拒绝，并直接告诉他缺什么。
 * 这不是在限制措辞，只是保证「输出格式」这条底线还在。
 */
const PROMPT_CONTRACT = {
  bundle: ['"tags"', '"display"', '"match"', '"episodes"'],
  series: ['namingStyle', 'rootTitle', 'extras'],
  format: ['prefix', 'literals'],
  groupTags: ['{{NAMES}}'],
}

/** 返回缺失的字段名（空数组 = 结构说明还在） */
const missingContract = (key, system) => (PROMPT_CONTRACT[key] || []).filter((token) => !system.includes(token))

/**
 * PUT /api/ai/prompts —— 写覆盖文件（不用改源码、不用重启，按 mtime 热加载）
 * ---------------------------------------------------------------------------
 * body：{ prompts: { bundle: { system?, custom? }, ... } }
 *   · 两段分开传：system 是我们的要求，custom 是用户补充；只传想改的那个即可
 *   · prompts: null 表示删掉覆盖文件，整份回退出厂默认
 * 校验：段名合法；system 给了就必须非空、不少于 20 字、且**保留输出结构的字段名**
 *（见 PROMPT_CONTRACT）。custom 随便写，但限长（它不是放长篇散文的地方）。
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
      throw fail('BAD_REQUEST', 'body 需要是 { prompts: { bundle: { system?, custom? } } }（传 null 表示恢复默认）')
    }
    const clean = {}
    for (const [key, value] of Object.entries(incoming)) {
      if (!PROMPT_KEYS.includes(key)) throw fail('BAD_REQUEST', `未知的提示词段 ${key}（可用：${PROMPT_KEYS.join(' / ')}）`)
      const entry = {}
      if (value?.system !== undefined) {
        const system = String(value.system).trim()
        if (system.length < 20) throw fail('BAD_REQUEST', `${key}.system 太短（至少要能说清任务；空 prompt 会污染缓存）`)
        const missing = missingContract(key, system)
        if (missing.length) {
          throw fail(
            'BAD_REQUEST',
            `${key} 缺少输出结构的字段名：${missing.join(' / ')}。模型靠这些名字对齐 JSON，删掉就会返回对不上的内容`,
          )
        }
        entry.system = system
      }
      if (value?.custom !== undefined) {
        const custom = String(value.custom).trim()
        if (custom.length > 4000) throw fail('BAD_REQUEST', `${key}.custom 太长了（上限 4000 字）`)
        entry.custom = custom
      }
      if (!Object.keys(entry).length) throw fail('BAD_REQUEST', `${key} 既没有 system 也没有 custom`)
      clean[key] = entry
    }
    if (!Object.keys(clean).length) throw fail('BAD_REQUEST', 'prompts 是空的，没什么可保存')

    /*
     * 写入是合并而不是覆盖：只 PUT 了 bundle 时，别的段不能因为这次保存被悄悄删掉。
     * 和出厂默认一样的部分不写进文件（还原成默认就等于「没改过」，以后升级默认提示词也生效）。
     *
     * **system 只认本次请求里显式给的**（`value.system`）：
     * 设置页只编辑 custom，如果把"上一次生效的 system"也照抄进覆盖文件，出厂提示词以后升级
     * 就永远盖不过它 —— 实测踩过：v11 的 system 被存进 data/prompts.json 后，v12 改了等于没改
     * （模型照旧返回文件名做 key 的对象）。所以没给 system 就回落到**当前出厂默认**。
     */
    const defaults = defaultPrompts()

    /** 当前覆盖文件（可能不存在 / 可能是坏文件） */
    let existing = {}
    if (existsSync(OVERRIDE_FILE)) {
      try {
        existing = JSON.parse(readFileSync(OVERRIDE_FILE, 'utf8')) || {}
      } catch {
        existing = {} // 旧文件坏了：本次保存顺手把它修好
      }
    }

    const merged = { ...existing }
    for (const [key, value] of Object.entries(clean)) {
      const nextSystem = value.system ?? defaults[key]?.system ?? ''
      const nextCustom = value.custom ?? prev.custom ?? ''
      const entry = {}
      if (nextSystem !== String(defaults[key]?.system || '').trim()) entry.system = nextSystem
      if (nextCustom) entry.custom = nextCustom
      if (Object.keys(entry).length) merged[key] = entry
      else delete merged[key]
    }

    if (!Object.keys(merged).length) {
      if (existsSync(OVERRIDE_FILE)) rmSync(OVERRIDE_FILE, { force: true })
    } else {
      writeFileSync(OVERRIDE_FILE, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
    }
    req.log.info({ updated: Object.keys(clean), kept: Object.keys(merged) }, 'ai.prompts update ok')
    res.json({
      ok: true,
      data: {
        source: promptSource(),
        keys: PROMPT_KEYS,
        customized: customizedKeys(),
        updated: Object.keys(clean),
      },
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
