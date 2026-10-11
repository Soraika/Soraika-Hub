/**
 * 系列链的纯逻辑 —— 走链 / 选代表行 / 校验 AI 输出 / 拼归档目录
 * ---------------------------------------------------------------------------
 * 不碰网络、不碰库、不调 AI：上游用 `loadRelated(bgmId)` 回调注入，所以这一层可以喂假数据单测。
 * 规则出处：CONVENTIONS.md §10.1（走链、AI 只做三件事）、§10.2（代表行）、§10.5（归档目录）。
 */

/** 只有这两个关系算「正传链」的边；其余关系一律**不展开** */
export const CHAIN_RELATIONS = new Set(['续集', '前传'])
/**
 * 收进系列、但不展开的关系（番外类）—— **必须是白名单，不能"除了续集前传都收"**
 * ---------------------------------------------------------------------------
 * 实测：`异世界四重奏` ↔ `OVERLORD` 之间是 **「角色出演」**（交叉作品，各自还有自己的正传链）。
 * 一旦把它们当番外收进来，两次走链会互相把对方写进自己的 `series_id` —— 结果两边混成一个系列、
 * `series_index` 还会撞（出现两个 index=1）。所以「衍生 / 角色出演 / 相同世界观 / 联动 / 系列 /
 * 原作 / 片头曲 / 游戏 / 书籍…」**连收都不收**（正是 §10.1 说的"别顺着联动跑到别的作品去"）。
 */
export const EXTRA_RELATIONS = new Set(['番外篇', '总集篇', '剧场版'])
/** BGM 条目类型：1 书籍 / 2 动画 / 3 音乐 / 4 游戏 / 6 三次元 —— 只要动画 */
export const TYPE_ANIME = 2
/** 番外归类取值（AI 只能从这个集合里选，越界的一律落「其他」） */
export const EXTRA_CATEGORIES = ['OVA', '剧场版', '总集篇', '衍生', '其他']
/** 目录风格：season = 同名续季（S01）/ volume = 异名平行作（01 化物语） */
export const NAMING_STYLES = ['season', 'volume']
/** 单条链的节点上限：防止关系成网时跑飞（正常系列远小于这个数） */
const MAX_CHAIN_NODES = 80

const pad2 = (n) => String(n).padStart(2, '0')

/**
 * 走系列链，同一遍里收集番外（番外零额外请求）
 * ---------------------------------------------------------------------------
 * 请求数 = 链长（进击的巨人 8 次、物语 12 次）。三条硬规则：
 *   · 只跟 `续集 / 前传` 且 `type === 2` 的边扩展；
 *   · 番外（`EXTRA_RELATIONS` 白名单里的）**只收集不展开**；白名单外的一律丢弃
 *     —— 交叉作品（角色出演 / 衍生）会把两个系列搅在一起；
 *   · 链序 = 从「没有前驱」的那个起、沿 `next` 走出来的顺序（不看年份、不看 id、不看列表顺序）。
 * @param {{ startBgmId:string|number,
 *           loadRelated:(bgmId:string)=>Promise<Array<{id:string,name?:string,nameCn?:string,relation:string,type:number}>>,
 *           log?:{warn:Function} }} params
 * @returns {Promise<{ chain:Array<{id:string,name:string,nameCn:string,index:number}>,
 *                     extras:Array<{id:string,name:string,nameCn:string,relation:string}>,
 *                     orphans:string[], truncated:boolean }>}
 */
export async function walkSeries({ startBgmId, loadRelated, log }) {
  const start = String(startBgmId)
  const extras = new Map()
  const seen = new Set()
  /** id → { id, name, nameCn, prev, next }（边存成「指向对方的 id + 名字」） */
  const nodes = new Map([[start, { id: start, name: '', nameCn: '', prev: null, next: null }]])
  const queue = [start]
  let truncated = false

  while (queue.length) {
    const id = queue.shift()
    if (seen.has(id)) continue
    seen.add(id)

    const list = await loadRelated(id)
    for (const item of list) {
      if (item.type !== TYPE_ANIME) continue // 书籍 / 游戏 / 音乐 / 三次元 一律不要
      const other = item.id
      if (!other) continue
      const brief = { id: other, name: item.name || '', nameCn: item.nameCn || '' }

      if (CHAIN_RELATIONS.has(item.relation)) {
        const node = nodes.get(id)
        if (node) {
          if (item.relation === '续集') node.next = brief
          else node.prev = brief
        }
        const known = nodes.get(other)
        if (known) {
          // 起点是自己先插进 nodes 的（名字为空）→ 别人提到它时顺手补上，日志里才看得见是谁
          if (!known.name && !known.nameCn) {
            known.name = brief.name
            known.nameCn = brief.nameCn
          }
        } else {
          if (nodes.size >= MAX_CHAIN_NODES) {
            truncated = true
            continue
          }
          // **反向指针也要设**：BGM 的关系经常是单向的（只有 S1 标了「续集→S2」，
          // S2 页面上没有「前传→S1」）。不设的话 S2 会被当成链头，
          // 链序就从中间断开（实测石纪元出现 7,8,1,2,3… 这种顺序）→ `series_index` 全错。
          const fresh = { ...brief, prev: null, next: null }
          const back = { id, name: node?.name || '', nameCn: node?.nameCn || '' }
          if (item.relation === '续集') fresh.prev = back
          else fresh.next = back
          nodes.set(other, fresh)
          if (!seen.has(other)) queue.push(other)
        }
      } else if (EXTRA_RELATIONS.has(item.relation) && !nodes.has(other) && other !== start) {
        // 番外：只收集（同一 id 可能挂在多个节点上，保留第一次见到的关系名）
        if (!extras.has(other)) extras.set(other, { ...brief, relation: item.relation })
      }
    }
  }

  // 拼有序链：从「没有前驱」的那个开始，沿 next 走
  const hasPrev = new Set([...nodes.values()].filter((n) => n.prev && nodes.has(n.prev.id)).map((n) => n.id))
  let cursor = [...nodes.values()].find((n) => !hasPrev.has(n.id))
  const chain = []
  const visited = new Set()
  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id)
    chain.push({ id: cursor.id, name: cursor.name, nameCn: cursor.nameCn, index: chain.length + 1 })
    cursor = cursor.next && nodes.has(cursor.next.id) ? nodes.get(cursor.next.id) : null
  }

  // 走不到链上的（关系没标全 / 成环）单独回报，方便排查
  const orphans = [...nodes.keys()].filter((id) => !visited.has(id))
  if (orphans.length && log?.warn) log.warn({ start, orphans }, 'series.walk orphans')

  const chainIds = new Set(chain.map((n) => n.id))
  return { chain, extras: [...extras.values()].filter((e) => !chainIds.has(e.id)), orphans, truncated }
}

/**
 * 选「代表行」= 链上**最靠前的、已在库的**成员（`series_id` 取它的 `anime.id`）
 * ---------------------------------------------------------------------------
 * 为什么不用 air_date 排：镜像 API 的 1 跳里**没有日期**，而链本身就**是播出顺序**
 * （我们正是沿 `续集/前传` 走出来的）→ 「链上最靠前」与「air_date 最早」等价，且零额外请求。
 * @param {Array<{id:string}>} chain
 * @param {Set<string>|Map<string, object>} library 库里已有的 bgmId
 */
export function pickRepresentative(chain, library) {
  const has = (id) => (library instanceof Map ? library.has(id) : Boolean(library?.has?.(id)))
  return chain.find((n) => has(n.id)) ?? null
}

/**
 * 校验并收敛 AI 的输出（§10.1）
 * ---------------------------------------------------------------------------
 * AI 只负责三件事：`namingStyle` / `rootTitle` / 番外归类；**链序是输入，不许它改**。
 * 这里做三件防护：风格越界 → null、title 限长、`extras` 里编造出来的 bgmId 一律丢掉。
 * @param {any} raw AI 返回的对象
 * @param {{ extraIds?:Array<string|number> }} [options] 本次请求里给出的番外 id
 * @returns {{ namingStyle:string|null, rootTitle:string, extras:Array<{bgmId:string, relation:string}> }}
 */
export function normalizeSeriesAiOutput(raw, { extraIds = [] } = {}) {
  const allowed = new Set(extraIds.map(String))
  const namingStyle = NAMING_STYLES.includes(raw?.namingStyle) ? raw.namingStyle : null
  // 键名兜底：模型有时会给 root_title / rootName 这类写法（换个模型就容易出现）
  const rootTitle = String(raw?.rootTitle ?? raw?.root_title ?? raw?.rootName ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)

  const extras = []
  for (const item of Array.isArray(raw?.extras) ? raw.extras : []) {
    const bgmId = String(item?.bgmId ?? '')
    if (!bgmId || !allowed.has(bgmId)) continue
    extras.push({ bgmId, relation: EXTRA_CATEGORIES.includes(item?.relation) ? item.relation : '其他' })
  }
  return { namingStyle, rootTitle, extras }
}

/**
 * 拼归档目录（§10.5）—— 只到目录，不含文件名
 * ---------------------------------------------------------------------------
 * season 风格 → `进击的巨人/S02`
 * volume 风格 → `物语系列/04 物语系列 第二季`
 * 番外        → `进击的巨人/OVA/02 LOST GIRLS`（序号由调用方按同类 air_date 排好传进来）
 * @param {{ rootTitle?:string, namingStyle?:string, seriesIndex?:number|null,
 *           seriesRelation?:string, title?:string, extraSeq?:number }} item
 */
export function archivePathOf({ rootTitle, namingStyle, seriesIndex, seriesRelation, title, extraSeq }) {
  const root = String(rootTitle || '').trim() || '未归类'
  const name = String(title || '').trim()

  if (seriesIndex == null) {
    const category = EXTRA_CATEGORIES.includes(seriesRelation) ? seriesRelation : '其他'
    const seq = Number.isFinite(extraSeq) ? `${pad2(extraSeq)} ` : ''
    return `${root}/${category}/${seq}${name}`
  }
  return namingStyle === 'volume' ? `${root}/${pad2(seriesIndex)} ${name}` : `${root}/S${pad2(seriesIndex)}`
}
