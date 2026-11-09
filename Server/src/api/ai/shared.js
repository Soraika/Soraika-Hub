/**
 * AI 能力层的公共零件 —— 去重 / 切批 / 并发 / 哈希 / 标签类型
 * ---------------------------------------------------------------------------
 * 这些函数与「哪家模型、什么 prompt」无关，四个能力（标签+集数、系列、格式、组标记）共用。
 * 放在这里而不是各写一份：切批大小、并发窗口、标签类型顺序一旦不一致，
 * 表现是「同一个东西在不同入口结果不同」，很难查。
 */
import { createHash } from 'node:crypto'

/**
 * 标签类型 → 展示顺序（version=修订版 / res / codec / sub / source / audio / other）
 * 注意：修订版的 type 就是 version。早先这里写成 revision，而生成标签时用的是 version，
 * 于是 TYPE_ORDER['version'] 是 undefined，比较函数返回 NaN，排序失效。
 */
export const TYPE_ORDER = { version: 0, res: 1, codec: 2, sub: 3, source: 4, audio: 5, other: 6 }
export const VALID_TYPES = new Set(Object.keys(TYPE_ORDER))

/**
 * 去重 + 去空。不截断：有多少条就分析多少条。
 * 截成「只分析前 N 条」就是漏，界面上会表现为「就这么点标签」。
 * 单次 prompt 的大小靠 chunk 分批控制，不靠丢数据。
 */
export function uniqueTitles(titles) {
  return [...new Set((titles || []).map((t) => String(t || '').trim()).filter(Boolean))]
}

/**
 * 切成若干批，每批最多 size 条
 * ---------------------------------------------------------------------------
 * 按条数切，不按字符切：切的是数组元素，一条文件名永远不会被切成两半
 * （文件名是筛选/解析的最小单位，切一半就废了）。字符数只影响单批体积，
 * 所以上限才叫「最多 N 条」。
 */
export function chunk(list, size) {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/**
 * 并发跑若干批（窗口 = limit），按输入顺序返回结果。
 * 为什么不用串行：全量分析下串行会让几百条资源等到天荒地老；
 * 为什么不用无脑 `Promise.all`：上游会限流。窗口 3 是稳与快的折中。
 */
export async function mapLimit(items, limit, fn) {
  const out = []
  for (let i = 0; i < items.length; i += limit) {
    const window = items.slice(i, i + limit)
    out.push(...(await Promise.all(window.map(fn))))
  }
  return out
}

/** 内容哈希（只取前 16 位：缓存 key 用，不需要全量强度） */
export const hashOf = (list) => createHash('sha1').update(list.join('\n')).digest('hex').slice(0, 16)

/** prompt 内容 hash：改提示词但忘了升版本号时，缓存也不会命中旧结果 */
export const promptHash = (text) => createHash('sha1').update(text).digest('hex').slice(0, 12)

/**
 * 只去掉完全等价的标签（两组 match 一模一样，筛出来的资源完全相同）
 * ---------------------------------------------------------------------------
 * 为什么不是「包含就算重复」（那是上一版规则，已废弃）：
 *   字符串包含只能猜。「简体内嵌」与「简体内嵌+繁体外挂」后者包含前者，
 *   但它是多了一条字幕轨，删掉就把一个真实选项藏了。判断性重复交给模型
 *   （prompt 里已经写清「同一维度只留一条、A 与 A+后缀只留 A」），这里不再二次猜。
 *
 * 留下的这一种是确定性的：match 集合相同，筛出来的资源集合就一定相同。
 * 保留名字更短的那个（更通用、更好读）。
 *
 * @param {{ name:string, type:string, match:string[] }[]} tags
 */
export function dropIdentical(tags) {
  const seen = new Map()
  const out = []
  for (const tag of tags) {
    // 排序后拼起来即"这个标签能筛出的资源集合"的指纹
    const key = `${tag.type}|${[...tag.match].map((m) => m.toLowerCase()).sort().join('\u0001')}`
    const prev = seen.get(key)
    if (!prev) {
      seen.set(key, tag)
      out.push(tag)
      continue
    }
    // 同一组 match：留名字更短的那个（下标替换，保持原顺序）
    if (tag.name.length < prev.name.length) {
      out[out.indexOf(prev)] = tag
      seen.set(key, tag)
    }
  }
  return out
}

/**
 * 模型返回的集数 → `{ 文件名: 集数 }`（纯函数，便于离线验收）
 * ---------------------------------------------------------------------------
 * v12 起模型**按输入顺序返回数组**（`episodes: [12, null, "1-12", ...]`），
 * 不再把文件名当 key 重复抄一遍 —— 输出 token 直接砍掉一半以上，而 AI 的耗时
 * 几乎全在输出上。
 *
 * 仍然兼容旧的「对象」写法：模型偶尔不听话、或者用户自己改了提示词，
 * 那句 `{ "文件名": 12 }` 也照收。两种都做**归一**（数字 / "1-12" / null），
 * 别的写法一律丢掉（宁缺勿错）。
 *
 * @param {unknown} raw 模型给的 episodes
 * @param {string[]} titles 这一批的文件名（数组形式时按序号对齐）
 * @returns {Record<string, number|string|null>}
 */
export function episodesFrom(raw, titles) {
  const list = Array.isArray(titles) ? titles : []
  const out = {}
  const put = (name, value) => {
    if (!name) return
    if (value === null) out[name] = null
    else if (typeof value === 'number') out[name] = value
    else if (typeof value === 'string') {
      const text = value.trim()
      if (/^\d{1,4}(-\d{1,4})?$/.test(text)) out[name] = text
    }
  }
  if (Array.isArray(raw)) {
    // 顺序即 index：第 i 个元素属于第 i 条文件名；比输入短就只认前面的（宁缺勿错）
    const count = Math.min(raw.length, list.length)
    for (let i = 0; i < count; i++) put(list[i], raw[i])
    return out
  }
  if (raw && typeof raw === 'object') {
    for (const [name, value] of Object.entries(raw)) put(name, value)
  }
  return out
}

/**
 * 把模型返回的多批标签合并成最终标签（纯函数，便于离线验收）
 * ---------------------------------------------------------------------------
 * 三件事：
 *   1. 同名合并 match（不同批里写法可能不同，合起来筛得更全）
 *   2. `all` 用**全量**重算：只有每条资源都命中才算「整批一致」
 *      （单批模型判断覆盖不了全部，所以要在这里按全量重算）
 *   3. `default`（提示词里可选的「默认勾选」）：合并时任一批说 true 就算 true；
 *      但整批一致的标签会被强制清成 false —— 它不做成筛选项，根本点不了
 *
 * @param {Array<{ parsed?: { tags?: any[] } }>} runs 每批模型的输出
 * @param {string[]} titles 这一批的全部文件名（用来重算 all）
 * @returns {Array<{ name:string, type:string, match:string[], all:boolean, default:boolean }>}
 */
export function mergeModelTags(runs, titles) {
  const merged = new Map()
  for (const run of runs || []) {
    for (const raw of Array.isArray(run?.parsed?.tags) ? run.parsed.tags : []) {
      const name = String(raw?.display || '').trim()
      if (!name) continue
      const match = (Array.isArray(raw?.match) ? raw.match : [name]).map((m) => String(m || '').trim()).filter(Boolean)
      const isDefault = raw?.default === true
      const hit = merged.get(name)
      if (hit) {
        hit.match = [...new Set([...hit.match, ...match])]
        hit.default = Boolean(hit.default) || isDefault
      } else {
        merged.set(name, {
          name,
          type: VALID_TYPES.has(raw?.type) ? raw.type : 'other',
          match,
          default: isDefault,
        })
      }
    }
  }

  const lowers = (titles || []).map((t) => String(t).toLowerCase())
  return [...merged.values()]
    .map((tag) => {
      const all = lowers.every((title) => tag.match.some((m) => title.includes(m.toLowerCase())))
      return { ...tag, all, default: all ? false : Boolean(tag.default) }
    })
    .filter((tag) => tag.name && tag.match.length)
}
