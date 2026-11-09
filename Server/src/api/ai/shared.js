/**
 * AI 能力层的公共零件 —— 去重 / 切批 / 并发 / 哈希 / 标签类型与去噪
 * ---------------------------------------------------------------------------
 * 这些函数与「哪家模型、什么 prompt」无关，四个能力（标签+集数、系列、格式、组标记）共用。
 * 放在这里而不是各写一份：切批大小、并发窗口、标签类型顺序这些一旦不一致，
 * 表现是「同一个东西在不同入口结果不同」，很难查。
 */
import { createHash } from 'node:crypto'

/** 标签类型 → 展示顺序（version=修订版 / res / codec / sub / source / audio / other）
 *  注意：**修订版的 type 就是 `version`** —— 早先这里写的是 `revision`，而生成标签时用的是
 *  `'version'`，于是排序里 `TYPE_ORDER['version']` 是 undefined → 比较函数返回 NaN，排序失效。 */
export const TYPE_ORDER = { version: 0, res: 1, codec: 2, sub: 3, source: 4, audio: 5, other: 6 }
export const VALID_TYPES = new Set(Object.keys(TYPE_ORDER))

/**
 * 去重 + 去空。**不截断** —— 有多少条就分析多少条
 * （用户要的是「全部信息都过 AI」；截成"只分析前 N 条"就是漏，界面上表现为"就这么点"）。
 * 单次 prompt 的大小靠 `chunk` 分批控制，不靠丢数据。
 */
export function uniqueTitles(titles) {
  return [...new Set((titles || []).map((t) => String(t || '').trim()).filter(Boolean))]
}

/**
 * 切成若干批，每批最多 size 条
 * ---------------------------------------------------------------------------
 * **按「条数」切，不按字符切**：切的是数组元素，一条文件名永远不会被切成两半
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
 * 去掉「被别的标签覆盖」的重复项。
 * ---------------------------------------------------------------------------
 * 模型很爱同时给 `HEVC` 与 `HEVC-10bit`、`简繁内封` 与 `简繁内封字幕`、`繁日` 与 `繁日字幕` ——
 * 后者只是在前者后面加了个后缀，点它筛出来的东西前者都能筛，纯噪音（而且看着"标签好乱"）。
 *
 * **为什么不让模型自己收敛**：prompt 里已经写了"不要返回重复维度"，但模型每次收敛程度不一样
 * （同一批它有时给 3 个有时给 6 个），而界面需要一个**稳定**的标签集 ——
 * 这种"纯字符串包含"的判断用本地规则是确定性的：免费、可测、每次结果一致。
 * prompt 负责"尽量少给"，这里负责"保证不漏"。
 *
 * 规则：同类型下，若 a 的任一写法包含 b 的某个写法（或 b 的名字），就去掉 a。
 * 加 `b.name.length < a.name.length` 是为了避免两个标签互删（相等长度时都不动）。
 */
export function dropCovered(tags) {
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
