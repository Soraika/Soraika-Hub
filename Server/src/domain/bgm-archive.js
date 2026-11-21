/**
 * Bangumi 离线 dump（github.com/bangumi/Archive）→ anime 档案字段
 * ---------------------------------------------------------------------------
 * 为什么不继续逐条打 API：档案补齐是「一条一次请求」，几千条老番要跑几十分钟，
 * 还会被上游限流。这份 dump 每周三 05:00(GMT+8) 导一次全站，本地流式过一遍就能把
 * 评分 / 评分人数 / 标签 / 简介 / 放送日 / 总集数补齐 —— **一条上游请求都不用发**。
 *
 * 数据形状（2026-11-03 的 dump 实测，jsonlines 一行一个 JSON）：
 *
 *   subject.jsonlines
 *     {"id":1,"type":1,"name":"…","name_cn":"…","infobox":"…","platform":1002,
 *      "summary":"…","nsfw":false,
 *      "tags":[{"name":"痞子蔡","count":24},…],     ← 对象数组，取 name
 *      "meta_tags":["ACT","NDS"],                   ← 纯字符串数组，优先用它
 *      "score":7.7,"score_details":{"1":1,…,"10":6},"rank":1937,
 *      "date":"1998-09-25",
 *      "favorite":{"wish":58,"done":129,"doing":7,"on_hold":8,"dropped":2}}  ← doing = 在看
 *
 *   episode.jsonlines
 *     {"id":3,"name":"…","name_cn":"","description":"","airdate":"","disc":0,
 *      "duration":"","subject_id":15,"sort":1,"type":0}   ← type 0 = 正篇（1 特别篇 / 2 OP / 3 ED…）
 *
 * 三个刻意的取舍：
 *   · **不写 year / season / weekday** —— 排期归属永远只有 Mikan 写（ARCHITECTURE §10.3）。
 *     dump 里的 date 只落到 `air_date`。
 *   · **不写 poster** —— dump 里没有封面（只有 infobox 的原文），封面继续走出图接口。
 *   · **不看 subject.type** —— 与现有 API 路径（按 bgmId 取条目）保持一致：
 *     Mikan 挂的是哪个条目就用哪个条目，不在这里二次判定类型。
 */
import { createReadStream } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { foldTitle } from './titles.js'

/** dump 里我们用得到的两个文件（其余 person / character 等与本项目无关） */
export const DUMP_FILES = Object.freeze({
  subject: 'subject.jsonlines',
  episode: 'episode.jsonlines',
})

/** 关系表（可选：老版本 dump 没有；有它就完全不用为了走链打上游） */
export const RELATION_FILE = 'subject-relations.jsonlines'

/**
 * dump 的 `relation_type` → 关系名
 * ---------------------------------------------------------------------------
 * 这些数字**不是猜的**：拿库里已知系列（蜡笔小新剧场版 34 部 / 链锯人 / 黑子的篮球 /
 * 少女乐队的呐喊）的同一批 id，把 dump 的行和 API `subjects/{id}/subjects` 返回的
 * 中文关系名逐条对照出来的（见 docs/ARCHITECTURE 决策 56）。
 * 只收系列链用得到的：正传 2/3，番外类 4/5/6，其余（音乐 / 书籍 / 三次元 / 联动）一律不进表。
 */
export const RELATION_NAMES = Object.freeze({
  1: '改编',
  2: '前传',
  3: '续集',
  4: '总集篇',
  5: '全集',
  6: '番外篇',
  12: '主线故事',
  14: '联动',
  3001: '原声集',
  3003: '片头曲',
  3004: '片尾曲',
  3005: '插入歌',
  3099: '其他',
})

/** 只有这些关系会进 `bgm_relation`（走链只需要正传边 + 番外白名单） */
export const RELATION_TYPES_KEPT = Object.freeze([2, 3, 4, 5, 6, 12])

/**
 * 逆关系：dump 通常两个方向都写（(A,3,B) + (B,2,A)），但实测有只写一边的，
 * 这时靠这张表补出「B 看 A 是什么关系」。
 */
export const INVERSE_RELATION = Object.freeze({ 2: 3, 3: 2, 4: 5, 5: 4, 6: 12, 12: 6, 14: 14 })

/** `relation_type` → 中文关系名（不认识的返回空串，调用方据此跳过） */
export const relationNameOf = (type) => RELATION_NAMES[Number(type)] || ''

/** 反向：中文关系名 → `relation_type`（在线补关系时把 API 的字符串写回成数字码） */
export const RELATION_CODES = Object.freeze(
  Object.fromEntries(Object.entries(RELATION_NAMES).map(([code, name]) => [name, Number(code)])),
)
export const relationCodeOf = (name) => RELATION_CODES[String(name || '').trim()] ?? 0

/** 反向关系的名字（例：A 的「续集」= B 的「前传」） */
export function inverseRelationNameOf(type) {
  const inverse = INVERSE_RELATION[Number(type)]
  return inverse ? relationNameOf(inverse) : ''
}

/** 标签最多留几个 —— 与 `lib/format.js#bgmToRow` 保持一致，别一边 8 个一边全量 */
export const TAG_LIMIT = 8

/**
 * 流式读 jsonlines（任何可读流都行：文件、zip 解压流）
 * ---------------------------------------------------------------------------
 * 为什么不用 `node:readline`：subject.jsonlines 有 950MB / 60 万行，readline 的逐行
 * 事件开销明显；自己按 '\n' 切块（带跨块残行）能快一倍以上，且内存恒定
 * —— 只留一块（默认 4MB）+ 半行。
 *
 * `raw: true` 时不解析 JSON，直接把原始行交给回调：调用方可以用
 * `leadingId()` / 一段正则先筛掉 99% 不关心的行，只对命中的那几百行做 JSON.parse。
 *
 * 跨块的**多字节字符**用 StringDecoder 兜住（zip 流给的是 Buffer，直接 toString 会把
 * 一个汉字的两个字节切开 → 出现 `\uFFFD`；这个坑在文件名里会直接变成乱码）。
 *
 * 回调是**同步**的（这里是文件解析，不是 IO 编排）—— 要写库就在回调里同步写，
 * 批量攒够再开事务。返回 `{ lines, bad, bytes }`，`bad` 是解析失败的行数（dump 偶有截断行）。
 *
 * @param {import('node:stream').Readable} stream
 * @param {(row: any) => void} onRow `raw: true` 时收到字符串，否则收到解析后的对象
 * @param {{ raw?: boolean }} [options]
 */
export async function readJsonLinesFrom(stream, onRow, { raw = false } = {}) {
  const stats = { lines: 0, bad: 0, bytes: 0 }
  const decoder = new StringDecoder('utf8')
  let rest = ''

  const emit = (line) => {
    stats.lines++
    if (raw) return onRow(line)
    let row
    try {
      row = JSON.parse(line)
    } catch {
      stats.bad++
      return
    }
    onRow(row)
  }

  for await (const chunk of stream) {
    const text = typeof chunk === 'string' ? chunk : decoder.write(chunk)
    stats.bytes += Buffer.byteLength(text)
    const combined = rest + text
    let start = 0
    let at = combined.indexOf('\n')
    while (at !== -1) {
      const line = combined.slice(start, at)
      start = at + 1
      if (line.trim()) emit(line)
      at = combined.indexOf('\n', start)
    }
    rest = start ? combined.slice(start) : combined
  }
  const tail = rest + decoder.end()
  if (tail.trim()) emit(tail)
  return stats
}

/**
 * 流式读 jsonlines 文件（薄包装，保持原来的调用方式）
 * @param {string} file
 * @param {(row: any) => void} onRow
 * @param {{ raw?: boolean, chunkBytes?: number }} [options]
 */
export async function readJsonLines(file, onRow, { raw = false, chunkBytes = 1 << 22 } = {}) {
  return readJsonLinesFrom(createReadStream(file, { encoding: 'utf8', highWaterMark: chunkBytes }), onRow, {
    raw,
  })
}

/**
 * 行首的条目 id —— `{"id":123,`
 * ---------------------------------------------------------------------------
 * 只为一件事：subject.jsonlines 有 950MB，而库里通常只有几千个 bgm_id，
 * 先按行首 id 筛一遍，JSON.parse 就只跑几千次。
 * 拿不到（格式变了 / 行首不是 id）返回 null，调用方应当**兜底整行解析**，
 * 这样 dump 换了字段顺序也不会静默漏数据。
 */
export function leadingId(line) {
  const match = /^\{"id":(\d+),/.exec(line)
  return match ? Number(match[1]) : null
}

/**
 * 标签：meta_tags（维基人维护的公共标签）优先，没有就退回用户标签
 * ---------------------------------------------------------------------------
 * 口径必须与 `lib/format.js#bgmToRow` 完全一致，否则「离线补的」和「接口补的」
 * 会存出两种顺序，前端题材行（`themeTags` 取前 2 个）会跳。
 */
export function archiveTags(subject, limit = TAG_LIMIT) {
  const meta = Array.isArray(subject?.meta_tags) ? subject.meta_tags : []
  const list = meta.length
    ? meta
    : (Array.isArray(subject?.tags) ? subject.tags : []).map((tag) =>
        typeof tag === 'string' ? tag : tag?.name,
      )
  return list.filter(Boolean).slice(0, limit)
}

/**
 * 评分人数 —— dump 没给 total，只有各档人数分布，自己加
 * （`{"1":1,"6":10,"7":18,…}` 之和就是接口里的 `rating.total`）
 */
export function ratingTotalOf(details) {
  if (!details || typeof details !== 'object') return null
  let total = 0
  for (const n of Object.values(details)) total += Number(n) || 0
  return total > 0 ? total : null
}

/**
 * 一条 dump 记录 → anime 的**档案字段**（排期 / 海报 / 系列字段都不在这里）
 * ---------------------------------------------------------------------------
 * 空值一律给 null：写库走 `COALESCE(?, col)`，null = 「这次没拿到，别覆盖已有值」。
 * 所以 dump 里 score 为 0（还没人评分）不会把库里已有的评分擦掉。
 *
 * @param {object} subject subject.jsonlines 的一行
 * @param {{ episodes?: number|null }} [extra] `episodes` = 该条目 type=0 的章节数
 */
export function archivePatch(subject, { episodes = null } = {}) {
  const score = Number(subject?.score)
  const watching = Number(subject?.favorite?.doing)
  const total = Number(episodes)
  return {
    title_cn: subject?.name_cn || null,
    score: Number.isFinite(score) && score > 0 ? score : null,
    rating_total: ratingTotalOf(subject?.score_details),
    tags: archiveTags(subject),
    watching: Number.isFinite(watching) && watching > 0 ? watching : null,
    summary: subject?.summary || null,
    air_date: subject?.date || null,
    total_episodes: Number.isFinite(total) && total > 0 ? total : null,
    // 下面两个是给 `bgm_subject` 用的（anime 没有这两列，多出来的键会被忽略）
    title_bgm_origin: subject?.name || null,
    platform: Number(subject?.platform) || null,
  }
}

/* ── 全站动画档案（bgm_subject 扩成「全站动画库」之后的新字段）─────────────
 *
 * 为什么要把 infobox 也存下来
 * ---------------------------------------------------------------------------
 * dump 的 `infobox` 是一段 MediaWiki 属性块（不是 JSON），里面是人类真正在意的信息：
 *
 *   {{Infobox animanga/TVAnime
 *   |中文名= Code Geass 反叛的鲁路修R2
 *   |别名={
 *   [叛逆的鲁路修R2]
 *   [Code Geass: Hangyaku no Lelouch R2]
 *   }
 *   |话数= 25
 *   |放送开始= 2008年4月6日
 *   |导演= 谷口悟朗
 *   |动画制作= サンライズ
 *   |系列构成= 大河内一楼
 *   …
 *
 * 以前只从里面取了「话数」，其余全丢 —— 而 agent 做推荐时「导演是谁 / 谁做的 / 哪年」
 * 恰恰是最有用的筛选维度（"帮我找几部跟这部同一个动画公司的高分番"）。
 * 解析成 JSON 之后，一条 SQL 就能筛（也便于 MCP 直接返回结构化结果），
 * 原文另存一份（`infobox` 列），解析漏了还能兜底。
 */

/** `tags_all` 最多留几个标签（展示只取 8 个，但推荐要更多；30 个足够覆盖口味） */
export const TAG_STORE_LIMIT = 30

/** 进 `bgm_tag` 倒排表的最小出现次数 —— 只有一个人打的标签对推荐没意义 */
export const TAG_ROW_MIN_COUNT = 5

/** infobox 里值得结构化出来的键（其余仍然原文留在 `infobox` 列里） */
export const STAFF_KEYS = Object.freeze([
  '中文名',
  '话数',
  '放送开始',
  '放送结束',
  '放送星期',
  '导演',
  '副导演',
  '系列构成',
  '脚本',
  '剧本',
  '原作',
  '原案',
  '人物设定',
  '人物原案',
  '机械设定',
  '音乐',
  '动画制作',
  '製作',
  '企划',
  '制片人',
  '美术监督',
  '色彩设计',
  '摄影监督',
  '音响监督',
  '播放电视台',
  '官方网站',
  'Copyright',
])

/**
 * 解析 dump 的 infobox 文本 → `{ 键: 值 }`
 * ---------------------------------------------------------------------------
 * 格式只有两条规则：`|键= 值`；多行值用 `{ … }` 包起来，里面一行一个 `[条目]`。
 * 解析不了（格式变了）就返回空对象 —— 调用方仍会把原文存进 `infobox` 列，不至于丢数据。
 */
export function parseInfobox(text) {
  if (typeof text !== 'string' || !text) return {}
  const out = {}
  let key = null
  let buf = []
  const commit = () => {
    if (key) {
      const value = buf.join('\n').replace(/^\{|\}$/g, '').trim()
      const clean = value
        .split(/\r?\n/)
        .map((line) => line.replace(/^\s*\[|\]\s*$/g, '').trim())
        .filter(Boolean)
        .join('、')
      if (clean) out[key] = clean.length > 400 ? `${clean.slice(0, 400)}…` : clean
    }
    key = null
    buf = []
  }
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const match = /^\s*\|\s*([^=|]{1,40})=([\s\S]*)$/.exec(line)
    if (match) {
      commit()
      key = match[1].trim()
      buf = [match[2]]
      continue
    }
    if (/^\s*\}/.test(line)) {
      commit()
      continue
    }
    if (key) buf.push(line)
  }
  commit()
  return out
}

/** infobox 里的「别名」→ 字符串数组（中日英罗马字混着，全是别名） */
export function infoboxAliases(map) {
  const raw = map?.别名
  if (!raw) return []
  return [...new Set(String(raw).split(/[、\n]/).map((s) => s.trim()).filter(Boolean))].slice(0, 12)
}

/** 只留 `STAFF_KEYS` 里有的键（值已经截断过） */
function pickStaff(map) {
  const out = {}
  for (const key of STAFF_KEYS) {
    if (map[key]) out[key] = map[key]
  }
  return out
}

/** infobox 的「话数」→ 数字（值形如 `25` / `12话` / `全25话`） */
function episodesFromInfobox(map) {
  const n = Number(/(\d{1,4})/.exec(String(map?.['话数'] || ''))?.[1])
  return Number.isFinite(n) && n > 0 ? n : null
}

/** 全量标签（含出现次数），按次数倒序 */
export function allTags(subject, limit = TAG_STORE_LIMIT) {
  const list = Array.isArray(subject?.tags) ? subject.tags : []
  return list
    .map((tag) => (typeof tag === 'string' ? { name: tag, count: null } : { name: tag?.name, count: Number(tag?.count) || null }))
    .filter((tag) => tag.name)
    .slice(0, limit)
}

/**
 * 一条 dump 记录 → `bgm_subject` 的**完整行**（全站动画库用）
 * ---------------------------------------------------------------------------
 * 与 `archivePatch()` 的分工：
 *   · `archivePatch()` 只产出「展示需要的 9 个字段」，写 `anime` 表（排期+展示）
 *   · 这里产出**所有能拿到的字段**，写 `bgm_subject`（全站动画档案，给 MCP / 推荐用）
 * 两者字段名刻意保持一致（title_bgm / score / tags / …），写库函数可以共用。
 *
 * @param {object} subject dump 的一行
 * @param {{ episodes?: number|null }} [extra] `episodes` = 该条目 type=0 的章节数（优先于 infobox 的话数）
 */
export function fullSubjectRow(subject, { episodes = null } = {}) {
  const id = Number(subject?.id)
  if (!Number.isFinite(id)) return null
  const infoboxMap = parseInfobox(subject?.infobox)
  const tagsAll = allTags(subject)
  const staff = pickStaff(infoboxMap)
  const aliases = infoboxAliases(infoboxMap)
  const titleCn = subject?.name_cn || null
  const titleOrigin = subject?.name || null
  const score = Number(subject?.score)
  const total = Number(episodes) || episodesFromInfobox(infoboxMap)
  return {
    bgm_id: String(id),
    title_bgm: titleCn || titleOrigin,
    title_bgm_origin: titleOrigin,
    summary: subject?.summary || null,
    score: Number.isFinite(score) && score > 0 ? score : null,
    rating_total: ratingTotalOf(subject?.score_details),
    tags: archiveTags(subject),
    watching: Number(subject?.favorite?.doing) > 0 ? Number(subject.favorite.doing) : null,
    platform: Number(subject?.platform) || null,
    first_air_date: subject?.date || null,
    total_episodes: total,
    type: Number(subject?.type) || null,
    bgm_rank: Number(subject?.rank) > 0 ? Number(subject.rank) : null,
    nsfw: subject?.nsfw ? 1 : 0,
    in_series: subject?.series ? 1 : 0,
    score_details: subject?.score_details || null,
    favorite: subject?.favorite || null,
    tags_all: tagsAll.length ? tagsAll : null,
    staff: Object.keys(staff).length ? staff : null,
    aliases: aliases.length ? aliases : null,
    infobox: subject?.infobox || null,
    name_fold: foldTitle(titleCn || titleOrigin || '') || null,
    source: 'dump',
  }
}

/** 一条完整行 → `bgm_tag` 的行（只留够热门的标签） */
export function tagRowsOf(row) {
  const tags = Array.isArray(row?.tags_all) ? row.tags_all : []
  return tags
    .filter((tag) => Number(tag.count) >= TAG_ROW_MIN_COUNT)
    .map((tag) => ({ bgm_id: row.bgm_id, name: tag.name, count: Number(tag.count) || null }))
}
