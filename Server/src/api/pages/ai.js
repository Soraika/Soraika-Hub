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
import { createMemCache } from '../../cache/mem.js'
import { chatJson } from '../sources/ai.js'

/** 标签类型 → 展示顺序（version=修订版 / res=分辨率 / codec=编码 / sub=字幕 / source=片源） */
const TYPE_ORDER = { revision: 0, res: 1, codec: 2, sub: 3, source: 4, other: 5 }
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
   **全量**：有多少条文件名就分析多少条。按 `ai.maxTitles`（单批上限，默认 120）
   切批、批间并发 3 跑完，结果合并去重 —— 绝不"只分析前 N 条"。 */

/** 拼一次请求的 user prompt：带作品上下文（番名 / 季），让模型知道自己在分析什么 */
const tagUserPrompt = (batch, context) =>
  `${context ? `作品：${context}\n\n` : ''}分析下面 ${batch.length} 条资源文件名：\n\n${batch
    .map((t, i) => `${i + 1}. ${t}`)
    .join('\n')}`

/* ── ① 标签解析 ──────────────────────────────────────────────────────────── */

/**
 * 提示词版本 —— 改动提示词时必须一起改它。
 * 缓存 key 里带上版本，否则改了 prompt 旧结果仍会命中，看起来「提示词没生效」。
 * v3：标签之外多给一批「信息性特征」（info），供界面只读展示 —— **已废弃**，见 v4。
 * v4：**去掉 info**。让模型总结「这批资源的整体特征」，产出的多半是废话
 *     （「均为 XX 字幕组作品」——列表本来就都是同一个组），还每次都要花钱；
 *     集数这类能从文件名算出来的，改由前端按规则算（`Web/src/utils/episode.js` 的 releaseHighlights）。
 * v5：**放宽"整批一样就不返回"** —— 旧版那条让"只有一条/整批同格式"时一个标签都没有，
 *     界面上看着像"没识别出来"（实际是模型老实遵守了指令）。
 *     现在整批一致的维度**也要返回**并标 `all: true`，由前端当"只读特征"展示（不可点、不参与筛选）。
 * v6：明说**修版信息（v2 / 修正版 / Rework / Repack）不要返回** —— 那条由本地规则出，
 *     模型再给一条 `v2 修订版` 就是重复项（而且它 type 是 source，去重规则按类型分，
 *     清不掉，只能从源头禁掉）。
 */
const TAG_PROMPT_VERSION = 'v6'

const TAG_SYSTEM_PROMPT = `你是动漫资源文件名解析专家。任务：从文件名列表里，找出**所有值得展示的维度**。

只返回 JSON：
{
  "tags": [
    { "display": "给人看的标签名", "match": ["文件名里实际出现的写法1", "写法2"], "type": "类型", "all": false }
  ]
}

每条候选都要判断"它能不能区分资源"，但**两种都要返回**：
- 能区分（all: false）：不同资源在这条上确实不一样，用户点一下能筛掉一部分
  （例：一半 1080P、一半 720P；一半内封简繁、一半繁日）
- 整批一致（all: true）：这批资源的取值**完全相同**。仍然要返回 —— 界面会把它当
  "整批特征"只读展示，不会做成可点的筛选项（例：整批都是 WEB-DL 1080p、整批都是简繁内封）
- 反过来更要避免的：**什么都返回**。字幕组名、番剧名、发布时间、容器格式（MP4/MKV）、
  音频编码（AAC/FLAC）、单集/合集信息、**修版信息（v2 / 修正版 / Rework / Repack）**——
  这些一律不返回（另有逻辑处理，返回了就是重复项）
- 同一维度的不同取值要**分开返回**（「1080P」与「720P」是两条），不要合并成一条
- 排序：能区分的（all: false）排前面、整批一致的排后面；同组内按展示价值排

type 取值：
- res：分辨率/画质（1080P、720P、BDRip…）
- codec：编码/位深（HEVC、AVC、10bit…）
- sub：字幕语言/形式（简繁内封、简繁、繁日…）
- source：片源/平台（BD、WebRip、WEB-DL、CATCHPLAY、B-Global…）
- other：其它值得展示的维度

其它要求：
- display 做归一化：1920x1080 / FHD / 1080p 统一成「1080P」；WEB-DL / WebDL 统一成「WEB-DL」
- match 必须从输入文件名里**逐字摘抄**实际写法（大小写照抄）——前端靠字符串包含来筛；
  all: true 的条目 match 也给（描述用），但前端不会拿它做筛选
- 只返回 JSON，不要 Markdown`

/**
 * 资源文件名 → 筛选标签
 * ---------------------------------------------------------------------------
 * · **全量分析**：有多少条文件名就分析多少条 —— 按 `ai.maxTitles`（单批上限）切批、
 *   批间并发 3 跑完，各批结果合并去重（同名标签的 `match` 取并集，筛得更全）
 * · **带作品上下文**：把番剧名 / 季一起给模型（它得知道在分析什么，才分得清"这是字幕组名"
 *   还是"这是片源"）
 * · `all`（整批一致）由**后端按全量数据重算**：单批模型的判断覆盖不了全量，
 *   而 `all` 的语义恰恰是"覆盖全部资源"
 * @param {string[]} titles 资源文件名列表
 * @param {{ log?: object, animeTitle?: string, season?: string|number }} [options]
 * @returns {Promise<{ tags: Array<{name:string,type:string,all:boolean,match:string[]}>,
 *                     model:string, cached:boolean, ms:number,
 *                     analyzed:number, batches:number }>}
 */
export async function classifyReleaseTags(titles, { log = logger, animeTitle = '', season = '' } = {}) {
  // 去重 + 去空，但**不截断**（全量）
  const list = [...new Set((titles || []).map((t) => String(t || '').trim()).filter(Boolean))]
  if (!list.length) throw fail('BAD_REQUEST', 'titles 需要是非空的文件名数组')

  const context = [animeTitle, season ? `第 ${season} 季` : ''].filter(Boolean).join(' · ')
  const key = `tags:${TAG_PROMPT_VERSION}:${hashOf([context, ...list])}`
  const cached = tagCache.get(key)
  if (cached) {
    log.debug({ titles: list.length, tags: cached.tags.length }, 'ai.tags cache-hit')
    return { ...cached, cached: true }
  }

  /* 全量分批：`ai.maxTitles` 是**单批上限**（默认 120，一次 prompt 别太大），
     超过就切多批、批间并发 3 跑完。
     旧实现是 `list.slice(0, maxTitles)` —— 只分析前 120 条，几百条资源的后半截
     直接没进过模型，用户看到的就是"怎么就这么点标签"。 */
  const batchSize = Math.max(1, config.ai.maxTitles || 40)
  const batches = chunk(list, batchSize)

  const runs = await mapLimit(batches, 3, async (batch) => {
    const { parsed, model, ms } = await chatJson({
      system: TAG_SYSTEM_PROMPT,
      user: tagUserPrompt(batch, context),
      log,
    })
    return { tags: Array.isArray(parsed?.tags) ? parsed.tags : [], model, ms }
  })

  const model = runs[runs.length - 1]?.model || config.ai.model
  const ms = runs.reduce((sum, run) => sum + (run.ms || 0), 0)

  // 收进 Map：同名标签把 match 合起来（不同批各看到的写法合并，前端按包含匹配更全）
  const merged = new Map()
  for (const run of runs) {
    for (const raw of run.tags) {
      const name = String(raw?.display || '').trim()
      if (!name) continue
      const match = (Array.isArray(raw?.match) ? raw.match : [name])
        .map((m) => String(m || '').trim())
        .filter(Boolean)
      const hit = merged.get(name)
      if (hit) hit.match = [...new Set([...hit.match, ...match])]
      else merged.set(name, { name, type: VALID_TYPES.has(raw?.type) ? raw.type : 'other', match })
    }
  }

  // all 按**全量**重算：写法能命中每一条才算"整批一致"（单批的判断覆盖不了全量）
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
      TYPE_ORDER[a.type] - TYPE_ORDER[b.type] ||
      a.name.localeCompare(b.name),
  )

  /* 修订版：字幕组修版重发（v2 / 修正版 / Rework / Repack…），这个标签**仍由本地规则**统一
     —— 它是确定性判定（`lib/format.js` 的 revisionOf），而且 `kind: 'revision'` 要驱动前端的
     「优选」语义（同集有修订用修订、没有的照旧保留），这条不能交给模型自由发挥。 */
  const revised = list.filter((title) => revisionOf(title) >= 2).length
  if (revised) tags.unshift({ name: '修订版', type: 'version', kind: 'revision', count: revised, match: [] })

  const result = { tags, model, ms, analyzed: list.length, batches: batches.length }
  tagCache.set(key, result)
  log.info(
    { titles: list.length, tags: tags.length, batches: batches.length, model, ms },
    'ai.tags ok',
  )
  return { ...result, cached: false }
}


/* ── ② 集数 / 季 / 纯番名解析 ───────────────────────────────────────────── */

/**
 * 提示词版本（与标签同一个道理）：集数缓存 24 小时，不带版本的话改完 prompt
 * 旧结果还会继续命中一整天，看起来「怎么改都没生效」。
 */
const EPISODE_PROMPT_VERSION = 'v1'

const EPISODE_SYSTEM_PROMPT = `你是动漫资源文件名解析专家。从文件名里提取下载与重命名需要的结构化信息。

只返回 JSON：
{
  "rawName": "纯番名（去掉「第二季 / S2 / Season 2 / 第2期」这类季数标识）",
  "season": 数字季度,
  "episodes": { "原文文件名": 集数数字 或 "起始-结束"（合集）或 null（判断不了 / OVA / 剧场版） }
}

规则：
- episodes 的 key 必须与输入的文件名**逐字一致**
- 集数只给数字；合集给 "1-12" 这种范围字符串；判断不了就给 null
- season：标题里有「第X季 / S3 / 第2期」就用它；没有则按集数连续性推断；再不行给 1
- rawName 用给到的作品标题去掉季数标识后返回；标题缺失时从文件名里取番名部分
- 只返回 JSON，不要 Markdown`

/**
 * 集数每批几条 —— 20 条一批：比 10 条少一半往返（120 条 = 6 批 ≈ 3 秒），
 * prompt 也还小（20 个文件名），不会把一次请求撑大。
 */
const EPISODE_BATCH = 20

/**
 * 资源文件名 → 纯番名 / 季 / 每条资源的集数
 * ---------------------------------------------------------------------------
 * · **全量**：有多少条文件名就解析多少条（不再 `slice(0, maxTitles)` 截断），
 *   按 `EPISODE_BATCH` 条一批、批间并发 3 跑完
 * · 番名 / 季以**第一批**的结果为准（同一部作品的资源不会各有各的季）
 * @param {string} animeTitle 作品标题（帮模型认清季数）
 * @param {string[]} titles 资源文件名列表
 * @returns {Promise<{ rawName:string, season:number, episodes:Record<string, number|string|null>,
 *                     model:string, batches:number, analyzed:number, cached:boolean, ms:number }>}
 */
export async function classifyEpisodes(animeTitle, titles, { log = logger } = {}) {
  const list = uniqueTitles(titles)
  if (!list.length) throw fail('BAD_REQUEST', 'titles 需要是非空的文件名数组')

  const title = String(animeTitle || '').trim()
  const key = `eps:${EPISODE_PROMPT_VERSION}:${hashOf([title, ...list])}`
  const cached = episodeCache.get(key)
  if (cached) {
    log.debug({ titles: list.length }, 'ai.episodes cache-hit')
    return { ...cached, cached: true }
  }

  const startedAt = Date.now()
  const batches = chunk(list, EPISODE_BATCH)

  // 批间并发 3：串行（旧实现）在几百条资源时要等几十个来回，太慢；无脑并发又会被限流
  const runs = await mapLimit(batches, 3, (batch) =>
    chatJson({
      system: EPISODE_SYSTEM_PROMPT,
      user: `作品标题：${title || '（无）'}\n\n文件名：\n${batch.map((t, n) => `${n + 1}. ${t}`).join('\n')}`,
      log,
    }),
  )

  let rawName = title || ''
  let season = 1
  const episodes = {}
  for (const [index, res] of runs.entries()) {
    // 季与番名以第一批为准（同一部作品的资源不会各有各的季）
    if (index === 0) {
      if (res.parsed?.rawName) rawName = String(res.parsed.rawName).trim()
      if (Number(res.parsed?.season) > 0) season = Number(res.parsed.season)
    }

    for (const [name, value] of Object.entries(res.parsed?.episodes || {})) {
      // 集数归一：数字 / "1-12" / null，别的写法一律丢掉（宁缺勿错）
      if (value === null) episodes[name] = null
      else if (typeof value === 'number') episodes[name] = value
      else if (typeof value === 'string' && /^\d{1,4}(-\d{1,4})?$/.test(value.trim())) episodes[name] = value.trim()
    }
  }

  const result = {
    rawName,
    season,
    episodes,
    model: runs[runs.length - 1]?.model || config.ai.model,
    batches: batches.length,
    analyzed: list.length,
    ms: Date.now() - startedAt,
  }
  episodeCache.set(key, result)
  log.info(
    { titles: list.length, batches: batches.length, matched: Object.keys(episodes).length, model: result.model, ms: result.ms },
    'ai.episodes ok',
  )
  return { ...result, cached: false }
}

/** 看板用：两个缓存的当前条目数 */
export const aiCacheStats = () => ({ tagCache: tagCache.size(), episodeCache: episodeCache.size() })
