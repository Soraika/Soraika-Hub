/**
 * AI 能力层 —— 把「一段文件名」变成面板能直接用的标签 / 集数
 * ---------------------------------------------------------------------------
 * 两个能力（对应旧版 classifier.js 的 classifyTags / classifyDownload）：
 *   ① classifyReleaseTags  —— 从资源文件名里提筛选标签（分辨率 / 字幕 / 片源…）
 *   ② classifyEpisodes     —— 从资源文件名里提「纯番名 / 第几季 / 每条资源的集数」
 *
 * 为什么要它们：Mikan 给的文件名是「文案」，不能直接拿来筛和重命名 ——
 *   标签给面板当筛选条件（点「1080P」就只剩 1080P 的资源），
 *   集数给下载重命名用（`番名 S01E03`）。
 *
 * 约定与边界：
 *   · 结果是**成品**：标签已按类型排好序（后端排序，前端不排序），集数已归一成数字或范围串
 *   · 缓存按「文件名内容哈希」而不是条数（旧版按数量做 key，不同内容同长度会互相串）
 *   · 不做的事：不落库 —— AI 结果属可重算的派生数据，进程内缓存够用（要持久化再加表）
 *   · 集数解析**分批串行**：一次任务可能上百条资源，串行能把上游限流风险压到最低，
 *     代价是慢（每批一次调用）；想快就把循环改成并发 3 左右
 */
import { createHash } from 'node:crypto'
import { config } from '../../config.js'
import { fail } from '../../lib/errors.js'
import { revisionOf } from '../../lib/format.js'
import { logger } from '../../lib/logger.js'
import { normalizeSeriesAiOutput } from '../../lib/series.js'
import { normalizeSignature } from '../../lib/release-match.js'
import { createMemCache } from '../../cache/mem.js'
import { chatJson } from '../sources/ai.js'

/** 标签类型 → 展示顺序（version=修订版 / res / codec / sub / source / audio / other）
 *  注意：**修订版的 type 就是 `version`** —— 早先这里写的是 `revision`，而生成标签时用的是
 *  `'version'`，于是排序里 `TYPE_ORDER['version']` 是 undefined → 比较函数返回 NaN，排序失效。 */
const TYPE_ORDER = { version: 0, res: 1, codec: 2, sub: 3, source: 4, audio: 5, other: 6 }
const VALID_TYPES = new Set(Object.keys(TYPE_ORDER))

/** 标签 30 分钟 / 集数 24 小时（都可配，**改完立即生效**），都按内容哈希缓存 */
const tagCache = createMemCache({ ttlMs: () => config.ai.tagCacheTtlMs, max: 200 })
const episodeCache = createMemCache({ ttlMs: () => config.ai.episodeCacheTtlMs, max: 200 })

/**
 * 去重 + 去空。**不截断** —— 有多少条就分析多少条
 * （用户要的是「全部信息都过 AI」；截成"只分析前 N 条"就是漏，界面上表现为"就这么点"）。
 * 单次 prompt 的大小靠下面 `chunk` 分批控制，不靠丢数据。
 */
function uniqueTitles(titles) {
  return [...new Set((titles || []).map((t) => String(t || '').trim()).filter(Boolean))]
}

/** 切成若干批，每批最多 size 条 */
function chunk(list, size) {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/**
 * 去掉「被别的标签覆盖」的重复项。
 * ---------------------------------------------------------------------------
 * 模型很爱同时给 `HEVC` 与 `HEVC-10bit`、`简繁内封` 与 `简繁内封字幕`、`繁日` 与 `繁日字幕` ——
 * 后者只是在前者后面加了个后缀，点它筛出来的东西前者都能筛，纯噪音（而且看着"标签好乱"）。
 * 规则：同类型下，若 a 的任一写法包含 b 的某个写法（或 b 的名字），就去掉 a。
 * 加 `b.name.length < a.name.length` 是为了避免两个标签互删（相等长度时都不动）。
 */
function dropCovered(tags) {
  return tags.filter(
    (a) =>
      !tags.some(
        (b) =>
          a !== b &&
          a.type === b.type &&
          b.name.length < a.name.length &&
          a.match.some(
            (am) =>
              am.toLowerCase().includes(b.name.toLowerCase()) ||
              b.match.some((bm) => am.toLowerCase().includes(bm.toLowerCase())),
          ),
      ),
  )
}

/**
 * 并发跑若干批（窗口 = limit），按输入顺序返回结果。
 * 为什么不用串行：全量分析下串行会让几百条资源等到天荒地老；
 * 为什么不用无脑 `Promise.all`：上游会限流。窗口 3 是稳与快的折中。
 */
async function mapLimit(items, limit, fn) {
  const out = []
  for (let i = 0; i < items.length; i += limit) {
    const window = items.slice(i, i + limit)
    out.push(...(await Promise.all(window.map(fn))))
  }
  return out
}

const hashOf = (list) => createHash('sha1').update(list.join('\n')).digest('hex').slice(0, 16)

/* ── 标签解析 ──────────────────────────────────────────────────────────────
   **全量**：有多少条文件名就分析多少条。单批大小是内部常数（`ai.maxTitles`，默认 120），
   切批后**批间并发**按 `ai.concurrency`（并发上限，默认 3）跑完，结果合并去重 —— 绝不"只分析前 N 条"。 */

/** 拼一次请求的 user prompt：带作品上下文（番名 / 季），让模型知道自己在分析什么 */
const tagUserPrompt = (batch, context) =>
  `${context ? `作品：${context}\n\n` : ''}分析下面 ${batch.length} 条资源文件名：\n\n${batch
    .map((t, i) => `${i + 1}. ${t}`)
    .join('\n')}`

/* ── ① 标签解析 ──────────────────────────────────────────────────────────── */

/**
 * 提示词版本 —— 改动提示词时必须一起改它。
 * 缓存 key 里带上版本 + prompt 内容 hash + 模型名，三者任一变化都不会命中旧结果。
 * v3：标签之外多给一批「信息性特征」（info），供界面只读展示 —— **已废弃**，见 v4。
 * v4：**去掉 info**（模型总结的"整体特征"多半是废话，还每次花钱）。
 * v5：整批一致的维度**也要返回**并标 `all: true`（否则"只有一条/整批同格式"时一个标签都没有）。
 * v6：明说**修版信息（v2 / 修正版 / Rework / Repack）不要返回**（那条由本地规则出）。
 * v7：**合并调用** —— 标签 + 纯番名 + 季 + 每条集数**一次拿齐**（原来是 2 次独立调用，
 *     token 与延迟都是两倍；而且两次调用看到的上下文不一样，季数还会对不上）。
 */
const BUNDLE_PROMPT_VERSION = 'v7'

/** prompt 内容 hash：改提示词但忘了升版本号时，缓存也不会命中旧结果 */
const PROMPT_HASH = (text) => createHash('sha1').update(text).digest('hex').slice(0, 12)

const BUNDLE_SYSTEM_PROMPT = `你是动漫资源文件名解析专家。一次给出三类产物：筛选标签、作品元信息、每条资源的集数。

只返回 JSON：
{
  "tags": [
    { "display": "给人看的标签名", "match": ["文件名里实际出现的写法1", "写法2"], "type": "类型", "all": false }
  ],
  "rawName": "纯番名（去掉「第二季 / S2 / Season 2 / 第2期」这类季数标识）",
  "season": 数字季度,
  "episodes": { "原文文件名": 集数数字 或 "起始-结束"（合集）或 null（判断不了 / OVA / 剧场版） }
}

【tags】找出**所有值得展示的维度**，每条都要判断"它能不能区分资源"，但**两种都要返回**：
- 能区分（all: false）：不同资源在这条上确实不一样，用户点一下能筛掉一部分
- 整批一致（all: true）：这批资源的取值**完全相同**。仍然要返回 —— 界面会把它当
  "整批特征"只读展示，不会做成可点的筛选项
- 更要避免的：**什么都返回**。字幕组名、番剧名、发布时间、容器格式（MP4/MKV）、
  音频编码（AAC/FLAC）、单集/合集信息、**修版信息（v2 / 修正版 / Rework / Repack）** ——
  这些一律不返回（另有逻辑处理，返回了就是重复项）
- 同一维度的不同取值要**分开返回**（「1080P」与「720P」是两条），不要合并成一条
- 排序：能区分的（all: false）排前面、整批一致的排后面；同组内按展示价值排
- type 取值：res（分辨率/画质）、codec（编码/位深）、sub（字幕语言/形式）、
  source（片源/平台）、other（其它值得展示的维度）
- display 做归一化：1920x1080 / FHD / 1080p 统一成「1080P」；WEB-DL / WebDL 统一成「WEB-DL」
- match 必须从输入文件名里**逐字摘抄**实际写法（大小写照抄）—— 前端靠字符串包含来筛

【rawName / season】
- rawName：给到的作品标题去掉季数标识后返回；标题缺失时从文件名里取番名部分
- season：标题里有「第X季 / S3 / 第2期」就用它；没有则按集数连续性推断；再不行给 1

【episodes】
- key 必须与输入的文件名**逐字一致**，一条不漏
- 集数只给数字；合集给 "1-12" 这种范围字符串；判断不了就给 null
- **4 位数年份不是集数**：「2022」「2023」这类是发行年（剧场版尤其常见）→ 给 null
- 剧场版 / OVA / 合集包如果没有明确集号，就给 null，不要拿年份或分辨率凑数

只返回 JSON，不要 Markdown。`

/** 拼一次请求的 user prompt：带作品上下文（番名 / 季），让模型知道自己在分析什么 */
const bundleUserPrompt = (batch, context) =>
  `${context ? `作品：${context}\n\n` : ''}分析下面 ${batch.length} 条资源文件名：\n\n${batch
    .map((t, i) => `${i + 1}. ${t}`)
    .join('\n')}`

/**
 * 缓存 key：**版本 + 模型 + prompt 内容 hash + 番名 + 文件名** 都参与
 * ---------------------------------------------------------------------------
 * 早先只带「版本 + 文件名」——换模型、或改了提示词却忘了升版本号时，
 * 旧结果会继续命中（表现出来就是"改了没生效"）。现在三个要素都进 key。
 * **季不参与 key**：同一个番名 + 同一批文件名，问一次就够了；
 * 把季写进 key 会让「标签带季、集数不带季」变成两次调用（合并调用的意义就没了）。
 */
const bundleCacheKey = (animeTitle, list) =>
  [BUNDLE_PROMPT_VERSION, config.ai.model, PROMPT_HASH(BUNDLE_SYSTEM_PROMPT), hashOf([animeTitle, ...list])].join(':')

/**
 * 同一个 key 的**在途请求**（并发合流）
 * ---------------------------------------------------------------------------
 * 面板会同时发两个请求：`/classify/tags` 和 `/classify/episodes` —— 它们算的是**同一个 bundle**
 * （同一番名 + 同一批文件名），原来两边都查缓存、都 miss，于是**并发打两次模型**
 * （实测日志里成对出现：`5466ms` + `5546ms`，同一批 36 条）。
 * 后果：延迟翻倍（同 key 的并发请求会被供应商排队）、token 翻倍。
 *
 * 现在：第一个请求负责真的去问模型，其余同 key 的请求**挂在同一个 Promise 上**，
 * 拿到结果后各自按 `cached: true` 返回 —— 一次模型调用，两个入口都用得上。
 */
const inflight = new Map()

/**
 * **一次调用拿三类产物**：标签 + 纯番名/季 + 每条集数
 * ---------------------------------------------------------------------------
 * 全量分批（单批 `ai.maxTitles` 条，批间按 `ai.concurrency` 并发），结果合并：
 *   · 标签：同名把 `match` 合起来，`all` 由**全量**重算（单批模型判断覆盖不了全部）
 *   · 番名 / 季：以**第一批**为准（同一部作品不会各有各的季）
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
        system: BUNDLE_SYSTEM_PROMPT,
        user: bundleUserPrompt(batch, context),
        log,
      })
      return { parsed: parsed || {}, model, ms }
    })

    const model = runs[runs.length - 1]?.model || config.ai.model

    /* ① 标签：同名合并 match；all 按全量重算 */
    const merged = new Map()
    const episodes = {}
    let rawName = String(animeTitle || '').trim()
    let seasonNo = 1

    for (const [index, run] of runs.entries()) {
      for (const raw of Array.isArray(run.parsed?.tags) ? run.parsed.tags : []) {
        const name = String(raw?.display || '').trim()
        if (!name) continue
        const match = (Array.isArray(raw?.match) ? raw.match : [name]).map((m) => String(m || '').trim()).filter(Boolean)
        const hit = merged.get(name)
        if (hit) hit.match = [...new Set([...hit.match, ...match])]
        else merged.set(name, { name, type: VALID_TYPES.has(raw?.type) ? raw.type : 'other', match })
      }

      // 番名 / 季以第一批为准
      if (index === 0) {
        if (run.parsed?.rawName) rawName = String(run.parsed.rawName).trim()
        if (Number(run.parsed?.season) > 0) seasonNo = Number(run.parsed.season)
      }

      for (const [name, value] of Object.entries(run.parsed?.episodes || {})) {
        // 集数归一：数字 / "1-12" / null，别的写法一律丢掉（宁缺勿错）
        if (value === null) episodes[name] = null
        else if (typeof value === 'number') episodes[name] = value
        else if (typeof value === 'string' && /^\d{1,4}(-\d{1,4})?$/.test(value.trim())) episodes[name] = value.trim()
      }
    }

    const lowers = list.map((t) => t.toLowerCase())
    const tags = dropCovered(
      [...merged.values()]
        .map((tag) => ({
          ...tag,
          all: lowers.every((title) => tag.match.some((m) => title.includes(m.toLowerCase()))),
        }))
        .filter((t) => t.name && t.match.length),
    ).sort(
      (a, b) =>
        Number(a.all) - Number(b.all) ||
        (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9) ||
        a.name.localeCompare(b.name),
    )

    /* 修订版：字幕组修版重发（v2 / 修正版 / Rework / Repack…），这个标签**仍由本地规则**统一
       —— 它是确定性判定（`lib/format.js` 的 revisionOf），而且 `kind: 'revision'` 要驱动前端的
       「优选」语义（同集有修订用修订、没有的照旧保留），这条不能交给模型自由发挥。 */
    const revised = list.filter((title) => revisionOf(title) >= 2).length
    if (revised) tags.unshift({ name: '修订版', type: 'version', kind: 'revision', count: revised, match: [] })

    const result = {
      tags,
      rawName,
      season: seasonNo,
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


/* ── ② 集数 / 季 / 纯番名解析 ───────────────────────────────────────────── */

/**
 * 资源文件名 → 纯番名 / 季 / 每条资源的集数（**合并调用**里的那部分）
 * ---------------------------------------------------------------------------
 * 与 `classifyReleaseTags` 走**同一次模型调用**（v7 起合并）：命中缓存时零成本，
 * 没命中时一次拿齐三类产物 —— 所以「先解析标签、再解析集数」不会变成两次调用。
 * 番名 / 季以第一批为准；集数逐条合并（认不出给 null）。
 * @param {string} animeTitle 作品标题（帮模型认清季数）
 * @param {string[]} titles 资源文件名列表
 * @returns {Promise<{ rawName:string, season:number, episodes:Record<string, number|string|null>,
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
    rawName: bundle.rawName,
    season: bundle.season,
    episodes: bundle.episodes,
    model: bundle.model,
    batches: bundle.batches,
    analyzed: bundle.analyzed,
    cached: bundle.cached,
    ms: bundle.ms,
  }
}

/* ── ③ 系列归一（命名风格 / 系列总名 / 番外归类）─────────────────────────────
   与标签、集数不同：**链序不由 AI 判断**（正传链是代码按「续集/前传」走出来的，作为输入给它），
   它只决定三件事：`namingStyle`（S01 还是 01 名字）、`rootTitle`（顶层目录名）、番外的归类。
   结果落在 anime 表（series_* 那几列），所以这里**不需要另设缓存**。
   改了下面的 prompt 必须同步升 SERIES_PROMPT_VERSION（否则老库里的旧结果看起来「没生效」）。 */

const SERIES_PROMPT_VERSION = 'v2'

const SERIES_SYSTEM_PROMPT = `你在给一个动画系列做归档命名。

只输出 JSON，不要 Markdown、不要解释：
{ "namingStyle": "season", "rootTitle": "系列总名", "allMovies": false,
  "extras": [ { "bgmId": "221781", "relation": "OVA" } ] }

namingStyle（只看【正传播出线】）：
- "season"：各条其实是同一部作品的不同季（名字剥掉「第二季 / Season 2 / 2期 / ver.N / 裸数字后缀 / R」后基本一致）
- "volume"：各条是不同标题的独立作品（化物语 / 伪物语 / 猫物语(黑) …）

allMovies：**整条系列是不是「全是剧场版」**（没有 TV 正传季）。
- true：所有成员都是电影（如「哆啦A梦：大雄的恐龙」「哆啦A梦：大雄的宇宙开拓史」… 一年一部的剧场版系列）
- false：有 TV 正传季，或者判断不了
注意：判断依据是「这些是电影」而不是名字里有没有「剧场版」三个字 ——
标题写成「XX：大雄的恐龙」也算电影；只有全系列都是电影时才给 true。

rootTitle：整个系列的目录名，中文 2~12 字、不带季标记。
- season → 剥掉季标记后的作品名（如「进击的巨人」）
- volume → 能概括全部的系列名（如「物语系列」）
- allMovies → 剧场版系列的统称（如「哆啦A梦剧场版」）

extras[].relation 只能取这 5 个值：
- OVA：OAD / OVA / 番外篇（有正片内容）
- 剧场版：名字含「剧场版」的（即使接口给的关系是「总集篇」也算剧场版）
- 总集篇：电视总集篇 / 回顾篇
- 衍生：Q版剧场 / 4D / 方言版 / 特别节目 / 音乐影像 这类非正片
- 其他：判断不了

规则：extras 的 bgmId 必须与输入一致、一条不漏；JSON 必须能被直接解析。`

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

  const { parsed, model, ms } = await chatJson({ system: SERIES_SYSTEM_PROMPT, user, provider, log })
  const out = normalizeSeriesAiOutput(parsed, { extraIds: extras.map((e) => e.id) })
  log.debug(
    { version: SERIES_PROMPT_VERSION, chain: (chain || []).length, extras: extras.length, got: out.extras.length, style: out.namingStyle, ms },
    'ai.series ok',
  )
  return { ...out, model, ms }
}

/* ── ④ 资源格式特征（从某个字幕组的样本里抽出「格式」）──────────────────────
   注意分工：**抽取**在这里（AI），**判断某条资源属于谁**在 lib/release-match.js
   （确定性匹配，免费且可测）。为什么这样分：几百条资源逐条问模型又慢又贵，
   而"这批名字的共有格式"问一次就够了。
   改了下面的 prompt 必须同步升 FORMAT_PROMPT_VERSION（缓存 key 带版本号）。 */

const FORMAT_PROMPT_VERSION = 'v2'

const FORMAT_SYSTEM_PROMPT = `你在看一批**来自同一个字幕组**的动画资源文件名（同一部番）。
任务：抽出这批名字共有的「格式特征」—— 用来在**全部字幕组**的资源里认出这个组的条目。

只输出 JSON，不要 Markdown、不要解释：
{ "prefix": "【DMHY】【黑色五叶草/Black_Clover】[", "literals": ["【DMHY】"] }

- prefix：这批文件名**从第一个字符起完全相同的那一段**。可以停在半个分段里（如末尾是「[」）。
  拿不准就省略这个字段。
- literals：这批文件名**每一条都包含**的字面片段 —— **只放"这个组的身份特征"**：
  字幕组标记（如「【DMHY】」）、番名的固定写法（如「Black_Clover」）。最多 3 个，越短越稳。
- 抽不出共同特征时输出：{ "prefix": "", "literals": [] }

**绝对不要**把会随单条资源变化的字段放进 literals：分辨率（720P / 1080P）、编码（x264 / HEVC）、
语言标记（[简体] / [繁体] / [简繁]）、媒体格式（MP4 / MKV）、集数、日期、番号 ——
同一个组会同时发这些不同版本，写死就等于把它们全漏掉。

硬性要求：输出会被直接用于 \`title.startsWith(prefix)\` 和 \`title.includes(literal)\`，
所以**只能给字面串** —— 不许给通配符、占位符（如 {ep}）、正则、省略号。`

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

  const key = `format:${FORMAT_PROMPT_VERSION}:${hashOf(list)}`
  const cached = formatCache.get(key)
  if (cached) return { ...cached, cached: true }

  try {
    const { parsed, model, ms } = await chatJson({
      system: FORMAT_SYSTEM_PROMPT,
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

const GROUP_PROMPT_VERSION = 'v2'

const GROUP_SYSTEM_PROMPT = `你在把「动画资源文件名开头的组标记」对应到我们库里已有的**字幕组名**。

【库里已有的字幕组名】（只能从这里选；对不上就写 null）
{{NAMES}}

只输出 JSON，不要 Markdown、不要解释：
{ "tags": { "DMHY": "动漫花园", "幻樱字幕组": "幻樱字幕组", "XXX": null } }

规则：
- 键必须是输入里的组标记，一字不改
- 值是上面的组名之一；**缩写 / 别称要能对上**（「DMHY」= 动漫花园、「LoliHouse」就是它自己）
- 实在对不上（库里没有这个组）→ 写 null，不要硬凑、不要新造名字`

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

  const key = `groupTags:${GROUP_PROMPT_VERSION}:${hashOf([...dict, ...list])}`
  const cached = groupTagCache.get(key)
  if (cached) return { ...cached }

  try {
    const { parsed } = await chatJson({
      system: GROUP_SYSTEM_PROMPT.replace('{{NAMES}}', dict.map((n, i) => `${i + 1}. ${n}`).join('\n')),
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
