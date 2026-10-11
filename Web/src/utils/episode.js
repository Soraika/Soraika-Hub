/**
 * 从资源文件名里取集数
 * ---------------------------------------------------------------------------
 * 资源条目的左侧会显示集数徽标，方便一眼看出「这一条是第几集」。
 * 集数的权威来源是 AI 的集数解析（`api/pages/ai.js` 的 classifyEpisodes），
 * 但那是按需触发的；这里用规则先给出**够用**的结果：Mikan 的文件名结构相当固定
 * （`[字幕组] 番名 - 04 [1080P][简繁]`），正则覆盖常见写法即可。
 * 取不到就返回空串 —— 界面据此不渲染徽标（不显示"?"这种占位）。
 */

const pad = (n) => String(n).padStart(2, '0')

/** 合集范围：`[01-12]`、`1-12END`、`01~12`、`1180-1200` → `01-12` 这种规范化写法 */
const RANGE_RE = [/[[(](\d{1,4})\s*[-~]\s*(\d{1,4})(?:end)?[\])]/i, /(\d{1,4})\s*[-~]\s*(\d{1,4})(?:end)?(?!\d)/i]

/**
 * 单集：按「越明确越优先」排列。位数放到 4 位 —— 长篇（海贼王 1180 集）就是 4 位数，
 * 之前写死 1-3 位，直接把 `- 1180` 漏掉了。
 */
const SINGLE_RES = [
  /[Ss]\d{1,2}\s?[Ee]\s?(\d{1,4})(?!\d)/, // S01E12 / S1E2（欧美源、CR/CATCHPLAY 这类常见）
  /(?:^|[^A-Za-z])[Ee][Pp]?\.?\s?(\d{1,4})(?!\d)/, // E12 / EP12 / Ep.12（只有集号没有季）
  /[[(]\s*(\d{1,4})\s*(?:v\d)?\s*[\])]/, // [04] / [04v2]
  /第\s*(\d{1,4})\s*[集话話回]/, // 第04集
  /(\d{1,4})\s*[集话話回]/, // 04话
  /[-–—]\s*(\d{1,4})\s*(?:v\d)?(?:[^\d]|$)/, // 番名 - 04 / - 1180
  /(\d{1,4})\s?[vV]\d(?!\d)/, // 04v2（没方括号也没前缀时的裸写法）
]

export function episodeOf(title) {
  const text = String(title || '')
  if (!text) return ''

  // 同一个标题在「筛选 / 排序 / 去重 / 徽标」里会被反复取集数，正则没必要每次重跑
  const hit = episodeCache.get(text)
  if (hit !== undefined) return hit

  const value = matchEpisode(text)
  if (episodeCache.size >= EPISODE_CACHE_MAX) episodeCache.clear()
  episodeCache.set(text, value)
  return value
}

const EPISODE_CACHE_MAX = 800
const episodeCache = new Map()

/** 真正的规则（被 episodeOf 包了一层 memo） */
function matchEpisode(text) {
  for (const re of RANGE_RE) {
    const hit = text.match(re)
    if (hit) return `${pad(hit[1])}-${pad(hit[2])}`
  }
  for (const re of SINGLE_RES) {
    const hit = text.match(re)
    if (hit) return pad(hit[1])
  }
  return ''
}

/** 是否合集（区间）—— 界面据此给徽标加个「合集」样式 */
export const isBatchEpisode = (episode) => /^\d{2,3}-\d{2,3}$/.test(String(episode || ''))

/**
 * 同一集有多个版本时，只留最高那一版（原版给修订版让位）
 * ---------------------------------------------------------------------------
 * 场景：字幕组后期发了修正版，同一集于是出现两条（v1 + v2）。开「修订版」筛后要做的
 * 不是"只显示修过的"，而是**把同集的旧版去掉**。规则（注意别做过头）：
 *   · 某集最高版本是 v2 → 该集的 v1 全部让位，只留 v2；
 *   · 某集只有 v1 → 照旧留着（不能因为"没修过"就整集消失）；
 *   · 同集同版本的多条（09 的 720P 与 1080P 都是 v1）→ 都留，它们不是版本关系；
 *   · 合集与识别不出集数的 → 不参与取舍（它们各是各的）。
 * 保持原顺序：这是"过滤"不是"重排"，列表顺序由调用方决定。
 * @param {Array<{title:string, revision?:number}>} items
 */
export function dedupeLatestRevisions(items = []) {
  const maxRev = new Map()
  for (const item of items) {
    const episode = episodeOf(item.title)
    if (!episode) continue
    const revision = Number(item.revision) || 1
    maxRev.set(episode, Math.max(maxRev.get(episode) || 1, revision))
  }
  return items.filter((item) => {
    const episode = episodeOf(item.title)
    if (!episode) return true
    return (Number(item.revision) || 1) >= (maxRev.get(episode) || 1)
  })
}

/**
 * 这批资源的整体特征（**本地按规则算，不问 AI**）—— 是"简报"，不是统计报表
 * ---------------------------------------------------------------------------
 * 目的：让人一眼评估这批资源值不值得下。所以只给"结论式"的信息，
 * **不列 ×N 计数**（`1080P × 30 / 720P × 17` 那种是报表，面板里没人读）。
 * 「共 N 条资源」永远有，保证这块不会空着 —— AI 说不出标签时（整批格式一致）
 * 它照样有内容可看。
 * @param {Array<{title:string}>} items 资源条目
 * @returns {string[]} 如 `['更新至第 25 话', '含 2 个合集包', '共 47 条资源']`
 */
/**
 * @param {Array<{title:string}>} items 资源条目
 * @param {Record<string, number|string|null>} [aiEpisodes] AI 解析出的集号（**优先用它**）
 */
export function releaseHighlights(items = [], aiEpisodes = {}) {
  const epOf = (item) => String(aiEpisodes[item.title] ?? '').trim() || episodeOf(item.title)
  const eps = items.map(epOf).filter(Boolean)
  const singles = eps
    .filter((episode) => !isBatchEpisode(episode))
    .map((episode) => Number(episode))
    .filter((n) => Number.isFinite(n))
  const batches = eps.filter(isBatchEpisode)

  const out = []
  if (singles.length) out.push(`更新至第 ${pad(Math.max(...singles))} 话`)
  if (batches.length) out.push(`含 ${batches.length} 个合集包`)
  out.push(`共 ${items.length} 条资源`)
  return out
}
