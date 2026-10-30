/**
 * 资源格式特征 —— 从「某个字幕组自己的样本」反推格式，再用它去全量里认领条目
 * ---------------------------------------------------------------------------
 * 为什么需要它：Mikan 的单字幕组 feed 只给最近 100 条（实测第 77~161 集），
 * 而不带 subgroupid 的**全量 feed 是完整的**（1~169 集）。但全量里没有「这条属于哪个组」，
 * 只能靠**格式特征**认领：拿这个组自己的样本抽出前缀/番名写法等特征，
 * 去全量里逐条匹配 —— 匹配上的就归到这个组名下。
 *
 * 为什么不让 AI 逐条判断：那样每条都要问模型（几百条 = 几百次调用）。
 * 这里 AI 只做一次「从样本里抽特征」，**判断由下面的确定性函数完成**（免费、可测、可复现）。
 *
 * 特征只认两种**安全**形式（不接受 AI 给的正则 —— 容易 ReDoS 或写错）：
 *   · prefix   : 必须是最前面的字面串（`【DMHY】`）
 *   · literals : 必须**同时出现**的字面片段（`【DMHY】`、`黑色五叶草`）
 */

/** 包住分段的括号：用于把公共前缀截到一个「干净边界」上 */
const OPEN = '[【（(「《'
const CLOSE = ']】）)」》'

/**
 * 最长公共前缀
 * @param {string[]} list
 * @returns {string}
 */
export function longestCommonPrefix(list = []) {
  const items = list.filter((t) => typeof t === 'string' && t)
  if (!items.length) return ''
  let prefix = items[0]
  for (const text of items.slice(1)) {
    let i = 0
    while (i < prefix.length && i < text.length && prefix[i] === text[i]) i++
    prefix = prefix.slice(0, i)
    if (!prefix) break
  }
  return prefix
}

/**
 * 把前缀截到「干净边界」：`【DMHY】【黑色五叶草/Black_Clover】[` → `【DMHY】【黑色五叶草/Black_Clover】[`
 * 末字是开括号就保留（它本身就是稳定的分段起点）；末字在半截字段里就回退到最近的闭括号之后。
 * @param {string} prefix
 */
function trimToBoundary(prefix) {
  if (!prefix) return ''
  const last = prefix[prefix.length - 1]
  if (OPEN.includes(last) || CLOSE.includes(last) || /\s/.test(last)) return prefix
  for (let i = prefix.length - 1; i >= 0; i--) {
    if (CLOSE.includes(prefix[i])) return prefix.slice(0, i + 1)
    if (OPEN.includes(prefix[i])) return prefix.slice(0, i + 1)
  }
  return prefix
}

/**
 * 从样本标题推一个「格式特征」（**确定性**，不依赖 AI —— AI 没配/失败时就是它兜底）
 * ---------------------------------------------------------------------------
 * 做法：① 取所有样本的最长公共前缀（截到干净边界）；② 若前缀太短，退而用
 * 「每条都出现的第一个方括号段」当字面片段（如 `【DMHY】`）。
 * @param {string[]} titles 这个字幕组自己的资源标题（样本）
 * @returns {{ prefix?: string, literals?: string[], source: 'samples' }|null}
 */
export function signatureFromSamples(titles = []) {
  const list = (titles || []).filter((t) => typeof t === 'string' && t.trim())
  if (list.length < 3) return null // 样本太少，推不出可信特征（宁可不用，也别乱认领）

  const prefix = trimToBoundary(longestCommonPrefix(list))
  if (prefix.length >= 3) return { prefix, source: 'samples' }

  // 前缀太短（比如首字符就不同）：找「每条都出现的第一个 【…】/[…] 段」
  const firstTag = list[0].match(/^([【[(][^】\])]{1,40}[】\])])/)
  const tag = firstTag?.[1]
  if (tag && list.every((t) => t.includes(tag))) return { prefix: tag, source: 'samples' }

  return null
}

/**
 * 校验并收敛「AI 抽出来的特征」—— 只留 prefix / literals 两种安全形式
 * @param {any} raw AI 输出
 * @param {string[]} samples 样本（用来验证特征确实能命中样本本身）
 */
export function normalizeSignature(raw, samples = []) {
  const prefix = typeof raw?.prefix === 'string' ? raw.prefix.trim().slice(0, 80) : ''
  const literals = Array.isArray(raw?.literals)
    ? raw.literals
        .filter((s) => typeof s === 'string' && s.trim())
        .map((s) => s.trim().slice(0, 40))
        .slice(0, 4)
    : []
  const sig = {
    ...(prefix ? { prefix } : {}),
    ...(literals.length ? { literals } : {}),
    source: 'ai',
  }
  if (!sig.prefix && !sig.literals) return null
  // 自检：特征必须能命中「至少一半样本」——否则这个特征抽错了，别拿去全量里乱认领
  const hit = samples.filter((t) => matchesSignature(t, sig)).length
  return samples.length && hit >= Math.ceil(samples.length / 2) ? sig : null
}

/**
 * 从资源文件名里取「组标记」—— 开头第一个 【…】 / […] / （…）
 * ---------------------------------------------------------------------------
 * Mikan 上发布组几乎都写在开头（`【DMHY】【番名】…` / `[c.c动漫][番名]…`），
 * 所以「这条属于哪个组」在绝大多数情况下是**确定性**的：取开头那段标记即可。
 * 取不到返回 ''（这条不参与按组归类，界面只显示文件名）。
 */
export function groupTagOf(title) {
  const m = String(title || '').match(/^\s*[【[(（]([^】\])）]{1,40})[】\])）]/)
  return m ? m[1].trim() : ''
}

/**
 * 统计一批资源里出现过的组标记（按条数降序）
 * @param {Array<{title:string}>} items
 * @returns {Array<{ tag:string, count:number }>}
 */
export function groupTagsOf(items = []) {
  const map = new Map()
  for (const it of items) {
    const tag = groupTagOf(it?.title)
    if (!tag) continue
    map.set(tag, (map.get(tag) || 0) + 1)
  }
  return [...map.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count)
}

/**
 * 给资源条目补上「所属字幕组」：用 tag → 群名 的映射做**确定性**匹配
 * @param {Array<{title:string}>} items 会被就地写入 `subgroup`
 * @param {Record<string,string>} tagToName 组标记 → 组名
 */
export function labelByGroupTag(items = [], tagToName = {}) {
  let labelled = 0
  for (const item of items) {
    const tag = groupTagOf(item?.title)
    const name = tag ? tagToName[tag] || null : null
    item.subgroup = name
    if (name) labelled++
  }
  return labelled
}

/**
 * 一条资源标题是否符合特征
 * @param {string} title
 * @param {{ prefix?: string, literals?: string[] }} signature
 */
export function matchesSignature(title, signature) {
  const text = String(title || '')
  if (!text || !signature) return false
  if (signature.prefix && !text.startsWith(signature.prefix)) return false
  if (signature.literals?.length && !signature.literals.every((part) => part && text.includes(part))) return false
  return Boolean(signature.prefix || signature.literals?.length)
}

/**
 * 用特征从全量里认领这个组的条目
 * ---------------------------------------------------------------------------
 * 兜底规则：认领结果**少于样本数**时判定特征不可靠（宁可返回样本，也不返回更少的），
 * 这样最坏情况就是退化成原来的「100 条」，不会比现在更差。
 * @param {Array<object>} allItems 全量 feed 解析出来的条目（含 title）
 * @param {{ prefix?: string, literals?: string[] }} signature
 * @param {Array<object>} samples 这个组自己的条目（用于兜底与自检）
 * @returns {{ items: Array<object>, matched: number, reliable: boolean }}
 */
export function claimBySignature(allItems = [], signature, samples = []) {
  if (!signature) return { items: samples, matched: samples.length, reliable: false }
  const matched = allItems.filter((it) => matchesSignature(it?.title, signature))
  const reliable = matched.length >= samples.length
  return { items: reliable ? matched : samples, matched: matched.length, reliable }
}
