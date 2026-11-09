/**
 * AI 能力层 —— 把「一段文件名」变成面板能直接用的标签 / 集数
 * ---------------------------------------------------------------------------
 * 两个入口（对应旧版 classifier.js 的 classifyTags / classifyDownload）：
 *   1. classifyReleaseTags  从资源文件名里提筛选标签（分辨率 / 字幕 / 片源…）
 *   2. classifyEpisodes     从资源文件名里提每条资源的集数
 *
 * 为什么要它们：Mikan 给的文件名是文案，不能直接拿来筛和重命名。
 * 标签给面板当筛选条件（点「1080P」就只剩 1080P 的资源），集数给下载重命名用。
 *
 * 约定与边界：
 *   · 结果是成品：标签已按类型排好序（后端排序，前端不排序），集数已归一成数字或范围串
 *   · 提示词是数据：四段 prompt 在 api/ai/prompts.json（可被 data/prompts.json 覆盖，热加载）。
 *     这个文件只管「怎么调」，不管「说什么」—— 改措辞不用改代码、不用重启
 *   · 缓存 key = 模型 + 提示词内容哈希 + 文件名内容哈希（改 prompt / 换模型都会自然 miss）
 *   · 不落库：AI 结果属可重算的派生数据，进程内缓存够用（要持久化再加表）
 *   · 番名与季不由这里产出：番名是调用方传进来的，季由系列的季位决定
 */
import { config } from '../../config.js'
import { fail } from '../../lib/errors.js'
import { revisionOf } from '../../lib/format.js'
import { logger } from '../../lib/logger.js'
import { normalizeSeriesAiOutput } from '../../lib/series.js'
import { normalizeSignature } from '../../lib/release-match.js'
import { createMemCache } from '../../cache/mem.js'
import { fillNames, promptHashOf, promptText, promptVersion } from '../ai/prompts.js'
import {
  TYPE_ORDER,
  VALID_TYPES,
  chunk,
  dropIdentical,
  hashOf,
  mapLimit,
  uniqueTitles,
} from '../ai/shared.js'
import { chatJson } from '../sources/ai.js'

/** 标签 30 分钟 / 集数 24 小时（都可配，**改完立即生效**），都按内容哈希缓存 */
const tagCache = createMemCache({ ttlMs: () => config.ai.tagCacheTtlMs, max: 200 })
const episodeCache = createMemCache({ ttlMs: () => config.ai.episodeCacheTtlMs, max: 200 })

/* ── ① 标签 + 集数（一次调用拿齐）────────────────────────────────────────────
   全量：有多少条文件名就分析多少条。单批大小是内部常数（ai.maxTitles，默认 40），
   切批后批间并发按 ai.concurrency（并发上限，默认 3）跑完，结果合并去重，绝不只分析前 N 条。
   提示词本身在 api/ai/prompts.json（可被 data/prompts.json 覆盖，热加载），
   这个文件只管怎么调，不管说什么。 */

/** 拼一次请求的 user prompt：带作品上下文（番名 / 季），让模型知道自己在分析什么 */
const bundleUserPrompt = (batch, context) =>
  `${context ? `作品：${context}\n\n` : ''}分析下面 ${batch.length} 条资源文件名：\n\n${batch
    .map((t, i) => `${i + 1}. ${t}`)
    .join('\n')}`

/**
 * 缓存 key：版本 + 模型 + 提示词内容 hash + 番名 + 文件名
 * ---------------------------------------------------------------------------
 * 早先只带「版本 + 文件名」：换模型、或改了提示词却忘了升版本号时，旧结果会继续命中
 * （表现出来就是「改了没生效」）。现在这些要素都进 key。
 * 季不参与 key：同一个番名 + 同一批文件名，问一次就够了；把季写进 key 会让
 * 「标签带季、集数不带季」变成两次调用（合并调用的意义就没了）。
 */
const bundleCacheKey = (animeTitle, list) =>
  [promptVersion('bundle'), config.ai.model, promptHashOf('bundle'), hashOf([animeTitle, ...list])].join(':')

/**
 * 同一个 key 的在途请求（并发合流）
 * ---------------------------------------------------------------------------
 * 面板会同时发两个请求：/classify/tags 和 /classify/episodes。它们算的是同一个 bundle
 * （同一番名 + 同一批文件名），原来两边都查缓存、都 miss，于是并发打两次模型
 * （实测日志里成对出现：5466ms + 5546ms，同一批 36 条）。
 * 后果：延迟翻倍（同 key 的并发请求会被供应商排队）、token 翻倍。
 *
 * 现在：第一个请求负责真的去问模型，其余同 key 的请求挂在同一个 Promise 上，
 * 拿到结果后各自按 cached:true 返回。一次模型调用，两个入口都用得上。
 */
const inflight = new Map()

/**
 * 一次调用拿两类产物：标签 + 每条集数
 * ---------------------------------------------------------------------------
 * 全量分批（单批 ai.maxTitles 条，批间按 ai.concurrency 并发），结果合并：
 *   · 标签：同名把 match 合起来，all 由全量重算（单批模型判断覆盖不了全部）
 *   · 集数：逐条合并，认不出就给 null（宁缺勿错）
 * 结果同时写进两个缓存（标签 30 分钟 / 集数 24 小时），各自按自己的 TTL 命中。
 */
async function classifyBundle(titles, { log = logger, animeTitle = '', season = '', kind = 'tags' } = {}) {
  const list = uniqueTitles(titles)
  if (!list.length) throw fail('BAD_REQUEST', 'titles 需要是非空的文件名数组')

  const context = [animeTitle, season ? `第 ${season} 季` : ''].filter(Boolean).join(' · ')
  const key = bundleCacheKey(String(animeTitle || '').trim(), list)
  const cache = kind === 'episodes' ? episodeCache : tagCache
  const cached = cache.get(key)
  if (cached) {
    log.debug({ titles: list.length, kind }, 'ai.bundle cache-hit')
    return { ...cached, cached: true }
  }

  /* 同 key 已经在问模型了 → 直接搭车（别再发一次） */
  const running = inflight.get(key)
  if (running) {
    log.debug({ titles: list.length, kind }, 'ai.bundle join-inflight')
    const shared = await running
    return { ...shared, cached: true }
  }

  const task = (async () => {
    const startedAt = Date.now()
    const batchSize = Math.max(1, config.ai.maxTitles || 40)
    const batches = chunk(list, batchSize)
    const limit = Math.min(Math.max(1, Number(config.ai.concurrency) || 1), 8)

    const runs = await mapLimit(batches, limit, async (batch) => {
      const { parsed, model, ms } = await chatJson({
        system: promptText('bundle'),
        user: bundleUserPrompt(batch, context),
        log,
      })
      return { parsed: parsed || {}, model, ms }
    })

    const model = runs[runs.length - 1]?.model || config.ai.model

    /* 标签：同名合并 match；all 按全量重算 */
    const merged = new Map()
    const episodes = {}

    for (const run of runs) {
      for (const raw of Array.isArray(run.parsed?.tags) ? run.parsed.tags : []) {
        const name = String(raw?.display || '').trim()
        if (!name) continue
        const match = (Array.isArray(raw?.match) ? raw.match : [name]).map((m) => String(m || '').trim()).filter(Boolean)
        const hit = merged.get(name)
        if (hit) hit.match = [...new Set([...hit.match, ...match])]
        else merged.set(name, { name, type: VALID_TYPES.has(raw?.type) ? raw.type : 'other', match })
      }

      for (const [name, value] of Object.entries(run.parsed?.episodes || {})) {
        // 集数归一：数字 / "1-12" / null，别的写法一律丢掉（宁缺勿错）
        if (value === null) episodes[name] = null
        else if (typeof value === 'number') episodes[name] = value
        else if (typeof value === 'string' && /^\d{1,4}(-\d{1,4})?$/.test(value.trim())) episodes[name] = value.trim()
      }
    }

    const lowers = list.map((t) => t.toLowerCase())
    const candidates = [...merged.values()]
      .map((tag) => ({
        ...tag,
        all: lowers.every((title) => tag.match.some((m) => title.includes(m.toLowerCase()))),
      }))
      .filter((t) => t.name && t.match.length)

    /*
     * 本地只兜「完全等价」这一种（两组 match 一模一样，筛出来的资源完全相同）。
     * 「包含就算重复」那种判断已经从代码里删掉了：它会把「简体内嵌」与
     * 「简体内嵌+繁体外挂」这种真实差异误删。判断性去重交给提示词（prompts.json 的【去重】段）。
     */
    const deduped = dropIdentical(candidates)
    if (deduped.length !== candidates.length) {
      log.debug({ from: candidates.length, to: deduped.length }, 'ai.tags identical-duplicates')
    }

    const tags = deduped.sort(
      (a, b) =>
        Number(a.all) - Number(b.all) ||
        (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9) ||
        a.name.localeCompare(b.name),
    )

    /*
     * 修订版（v2 / 修正版 / Rework / Repack）这个标签仍由本地规则统一：
     * 它是确定性判定（lib/format.js 的 revisionOf），而且 kind=revision 要驱动前端的
     * 「优选」语义（同集有修订用修订、没有的照旧保留），不能交给模型自由发挥。
     */
    const revised = list.filter((title) => revisionOf(title) >= 2).length
    if (revised) tags.unshift({ name: '修订版', type: 'version', kind: 'revision', count: revised, match: [] })

    /*
     * 结果里只有标签与集数。番名不进结果：调用方本来就把它传进来了（animeTitle），
     * 让模型再吐一遍纯属多花 token、多一次出错机会；季由系列的季位决定，也不该由这里猜。
     */
    /*
     * 结构兜底：正常一批总有东西（标签至少 all:true，集数至少逐条 null）。
     * 两边都空说明模型没按约定回（多半是提示词被改坏或模型跑偏）。这种情况必须报错，
     * 不能返回空结果：空结果会被写进缓存，把「什么都没解析出来」固化半小时，
     * 事后只会看到「标签突然没了」。
     */
    if (!tags.length && !Object.keys(episodes).length) {
      throw fail('PARSE', '模型返回的结构不符合约定（既没有 tags 也没有 episodes）：请检查提示词是否被改动')
    }

    const result = {
      tags,
      episodes,
      model,
      ms: Date.now() - startedAt,
      analyzed: list.length,
      batches: batches.length,
    }
    tagCache.set(key, result)
    episodeCache.set(key, result)
    log.info(
      {
        titles: list.length,
        tags: tags.length,
        episodes: Object.keys(episodes).length,
        batches: batches.length,
        model,
        ms: result.ms,
      },
      'ai.bundle ok',
    )
    return result
  })()

  inflight.set(key, task)
  try {
    const result = await task
    return { ...result, cached: false }
  } finally {
    inflight.delete(key)
  }
}

/**
 * 资源文件名 → 筛选标签（**合并调用**里的 tags 那一部分）
 * @param {string[]} titles 资源文件名列表
 * @param {{ log?: object, animeTitle?: string, season?: string|number }} [options]
 * @returns {Promise<{ tags: Array<{name:string,type:string,all:boolean,match:string[]}>,
 *                     model:string, cached:boolean, ms:number,
 *                     analyzed:number, batches:number }>}
 */
export async function classifyReleaseTags(titles, options = {}) {
  const { tags, model, ms, analyzed, batches, cached } = await classifyBundle(titles, { ...options, kind: 'tags' })
  return { tags, model, ms, analyzed, batches, cached }
}


/* ── ② 集数解析 ───────────────────────────────────────────────────────────── */

/**
 * 资源文件名 → 每条资源的集数（合并调用里的那部分）
 * ---------------------------------------------------------------------------
 * 与 classifyReleaseTags 走同一次模型调用：命中缓存时零成本，没命中时一次拿齐。
 * 番名不进结果（调用方本来就传进来了），季由系列的季位决定。
 * @param {string} animeTitle 作品标题（帮模型认清这批资源属于谁）
 * @param {string[]} titles 资源文件名列表
 * @returns {Promise<{ episodes:Record<string, number|string|null>,
 *                     model:string, batches:number, analyzed:number, cached:boolean, ms:number }>}
 */
export async function classifyEpisodes(animeTitle, titles, options = {}) {
  const { log = logger } = options
  const list = uniqueTitles(titles)
  if (!list.length) throw fail('BAD_REQUEST', 'titles 需要是非空的文件名数组')

  const bundle = await classifyBundle(list, {
    ...options,
    log,
    animeTitle: String(animeTitle || '').trim(),
    kind: 'episodes',
  })
  return {
    episodes: bundle.episodes,
    model: bundle.model,
    batches: bundle.batches,
    analyzed: bundle.analyzed,
    cached: bundle.cached,
    ms: bundle.ms,
  }
}

/* ── ③ 系列归一（命名风格 / 系列总名 / 番外归类）─────────────────────────────
   与标签、集数不同：链序不由 AI 判断（正传链是代码按「续集/前传」走出来的，作为输入给它），
   它只决定三件事：namingStyle（S01 还是 01 名字）、rootTitle（顶层目录名）、番外的归类。
   结果落在 anime 表（series_* 那几列），所以这里不需要另设缓存。
   提示词在 prompts.json 的 series 段（改措辞不用动这里，缓存 key 带内容 hash）。 */


/**
 * 系列归一 —— 一次调用决定 namingStyle / rootTitle / 番外归类
 * ---------------------------------------------------------------------------
 * 输入分两段：正传链（已确定、顺序不许改）+ 其余关联作品（要归类）。
 * 输出里的 extras 会按「本次给出的 bgmId 集合」过滤（见 normalizeSeriesAiOutput）。
 * @param {{ chain:Array<{id:string,name:string,nameCn:string,index:number}>,
 *           extras:Array<{id:string,name:string,nameCn:string,relation:string}>,
 *           provider?:object, log?:object }} params
 * @returns {Promise<{ namingStyle:string|null, rootTitle:string,
 *                     extras:Array<{bgmId:string, relation:string}>, model:string, ms:number }>}
 */
export async function classifySeries({ chain, extras = [], provider, log = logger } = {}) {
  const chainLines = (chain || [])
    .map((n, i) => `${i + 1}. ${n.nameCn || n.name}${n.nameCn && n.name ? `（${n.name}）` : ''}`)
    .join('\n')
  const extraLines = extras.length
    ? extras.map((e) => `${e.id} | ${e.nameCn || e.name} | 接口给的关系：${e.relation}`).join('\n')
    : '（无）'
  const user = `【正传播出线】（按播出顺序，不要改动）
${chainLines || '（无）'}

【其余关联作品】（需要归类）
${extraLines}`

  const { parsed, model, ms } = await chatJson({ system: promptText('series'), user, provider, log })
  const out = normalizeSeriesAiOutput(parsed, { extraIds: extras.map((e) => e.id) })
  log.debug(
    { version: promptVersion('series'), chain: (chain || []).length, extras: extras.length, got: out.extras.length, style: out.namingStyle, ms },
    'ai.series ok',
  )
  return { ...out, model, ms }
}

/* ── ④ 资源格式特征（从某个字幕组的样本里抽出「格式」）──────────────────────
   注意分工：**抽取**在这里（AI），**判断某条资源属于谁**在 lib/release-match.js
   （确定性匹配，免费且可测）。为什么这样分：几百条资源逐条问模型又慢又贵，
   而"这批名字的共有格式"问一次就够了。
   改了下面的 prompt 必须同步升 FORMAT_PROMPT_VERSION（缓存 key 带版本号）。 */


/** 特征缓存：同一批样本 6 小时内不重复问（key = 样本内容哈希） */
const formatCache = createMemCache({ ttlMs: () => 6 * 60 * 60 * 1000, max: 200 })

/**
 * 从「某个字幕组自己的资源文件名」抽出格式特征
 * ---------------------------------------------------------------------------
 * 用途：Mikan 的单字幕组 feed 只给最近 100 条，要靠这个特征去**全量 feed** 里
 * 把该组的其它条目认领回来（认领逻辑见 lib/release-match.js）。
 * 没配 AI / 样本太少 / 抽不出来 → 返回 null，调用方用 `signatureFromSamples` 确定性兜底。
 * @param {string[]} samples 同一个字幕组的资源文件名（取前 20 条足够）
 * @returns {Promise<{prefix?:string, literals?:string[], source:'ai', cached:boolean}|null>}
 */
export async function classifyReleaseFormat(samples = [], { provider, log = logger } = {}) {
  const list = uniqueTitles(samples).slice(0, 20)
  if (list.length < 3) return null
  if (!config.ai.enabled) return null

  const key = `format:${promptVersion('format')}:${promptHashOf('format')}:${hashOf(list)}`
  const cached = formatCache.get(key)
  if (cached) return { ...cached, cached: true }

  try {
    const { parsed, model, ms } = await chatJson({
      system: promptText('format'),
      user: JSON.stringify({ samples: list }),
      provider,
      log,
    })
    const sig = normalizeSignature(parsed, list)
    if (!sig) {
      log.debug({ samples: list.length, ms }, 'ai.format no-signature')
      return null
    }
    formatCache.set(key, { ...sig, model })
    log.info({ samples: list.length, prefix: sig.prefix, literals: sig.literals, model, ms }, 'ai.format ok')
    return { ...sig, cached: false }
  } catch (err) {
    // 抽不出来不当错误：调用方会退回确定性特征
    log.warn({ samples: list.length, err: err.message }, 'ai.format fail')
    return null
  }
}

/* ── ⑤ 组标记 → 字幕组名（详情页拿不到组列表时用）──────────────────────────
   为什么要它：Mikan 详情页 404 的老番拿不到「这部有哪些组」，但**全量 feed 是完整的**，
   而且每条文件名开头几乎都带组标记（`【DMHY】` / `[c.c动漫]`…）。
   所以只把**去重后的组标记**（通常 5~10 个）+ **我们库里的组名字典**发给模型做一次映射，
   逐条归类交给确定性前缀匹配（`lib/release-match.js#groupTagOf`）—— 一次调用搞定，
   不用把几百条文件名都塞给模型（那样又慢又贵）。
   改 prompt 必须同步升 GROUP_PROMPT_VERSION。 */


/** 组标记映射缓存：同一部番同一批标记 24 小时内不重复问 */
const groupTagCache = createMemCache({ ttlMs: () => 24 * 60 * 60 * 1000, max: 100 })

/**
 * 把「组标记」映射到库里已有的字幕组名（**一次调用**，不分批）
 * ---------------------------------------------------------------------------
 * @param {string[]} tags 去重后的组标记（如 `['DMHY', '幻樱字幕组']`）
 * @param {string[]} names 库里已有的字幕组名（`subgroup` 表的字典）
 * @returns {Promise<Record<string,string|null>|null>} 标记 → 组名；AI 不可用/失败返回 null
 */
export async function classifyGroupTags(tags = [], names = [], { provider, log = logger } = {}) {
  const list = [...new Set((tags || []).map((t) => String(t || '').trim()).filter(Boolean))].slice(0, 40)
  const dict = [...new Set((names || []).map((n) => String(n || '').trim()).filter(Boolean))]
  if (!list.length || !dict.length) return null
  if (!config.ai.enabled) return null

  const key = `groupTags:${promptVersion('groupTags')}:${promptHashOf('groupTags')}:${hashOf([...dict, ...list])}`
  const cached = groupTagCache.get(key)
  if (cached) return { ...cached }

  try {
    const { parsed } = await chatJson({
      system: fillNames(promptText('groupTags'), dict),
      user: JSON.stringify({ tags: list }),
      provider,
      log,
    })
    const allowed = new Set(dict)
    const out = {}
    let hit = 0
    for (const tag of list) {
      const v = parsed?.tags?.[tag]
      const name = typeof v === 'string' && allowed.has(v.trim()) ? v.trim() : null
      out[tag] = name
      if (name) hit++
    }
    groupTagCache.set(key, out)
    log.info({ tags: list.length, names: dict.length, mapped: hit }, 'ai.groupTags ok')
    return out
  } catch (err) {
    log.warn({ tags: list.length, names: dict.length, err: err.message }, 'ai.groupTags fail')
    return null
  }
}

/** 看板用：各缓存的当前条目数 */
export const aiCacheStats = () => ({
  tagCache: tagCache.size(),
  episodeCache: episodeCache.size(),
  formatCache: formatCache.size(),
  groupTagCache: groupTagCache.size(),
})
