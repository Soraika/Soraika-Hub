/**
 * 资源元数据：画质 / 字幕 / 片源 —— **从文件名里摘，写进 qB 标签存下来**
 * ---------------------------------------------------------------------------
 * 为什么要存成标签，而不是每次从文件名现推：
 *   · 改名之后就没了。旧系统把 113/176 个文件改成了 `番名 S02E23.mp4`，
 *     画质/字幕信息当场丢失，事后**不可能**再推出来（原来的种子名被覆盖成 `[id][番名][季][集][组]`）
 *   · qB 标签是**跟着种子走的**（改名、换目录都不影响），qB 里也能直接按标签筛
 *   · 我们自己的机器读得懂，人看得也懂（`res:1080P` 比一串位置参数清楚）
 * 所以：**加种时打标签，读取时先看标签、没有才回退到解析名字**（兼容历史数据）。
 *
 * 标签键很短，尽量少占地方：
 *   `soraika`（是不是本程序加的）· `mid:{mikanId}` · `sg:{字幕组}` · `res:` · `sub:` · `src:`
 */

/** 画质：标准写法 `1080p`，以及宽高写法 `1920x1080`（旧资源常见） */
const RES_RE = /\b(4320p|2160p|1080p|720p|480p|360p|4k|8k)\b/i
const WH_RE = /\b(\d{3,4})\s*[xX×]\s*(\d{3,4})\b/
const RES_BY_WH = { '3840x2160': '2160P', '1920x1080': '1080P', '1280x720': '720P', '720x480': '480P' }

/** 字幕：中文标记优先（国内资源最常用来区分），其次英文缩写 */
const SUB_RE = /(简繁|简日|繁日|简中|繁中|简体|繁体|内嵌|内封|外挂|双语|CHS|CHT|GB|BIG5|JPSC|JPTC|JPCH|JPN)/i
/** 片源 */
const SRC_RE = /\b(WEB-?DL|WEB-?Rip|BluRay|BDRip|BD|HDTV|DVDRip)\b/i

/** 统一大小写与空白：`web-dl` → `WEB-DL`、`1080p` → `1080P` */
const norm = (s) =>
  String(s)
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()

/** 画质：先认 `1080p`，再认 `1920x1080` */
export function resolutionOf(text) {
  const s = String(text || '')
  const std = s.match(RES_RE)
  if (std) return norm(std[1])
  const wh = s.match(WH_RE)
  if (!wh) return ''
  return RES_BY_WH[`${wh[1]}x${wh[2]}`] || `${wh[2]}P`
}

/** 字幕 / 片源（同一条文件名里只取第一个，多语言版本靠标签区分就够了） */
export const subtitleOf = (text) => (String(text || '').match(SUB_RE) ? norm(String(text).match(SUB_RE)[1]) : '')
export const sourceOf = (text) => (String(text || '').match(SRC_RE) ? norm(String(text).match(SRC_RE)[1]) : '')

/**
 * 从资源标题里摘元数据
 * @param {string} text 发布名（Mikan 资源标题 / 种子名 / 文件名都可以）
 * @returns {{ res: string, sub: string, src: string }}
 */
export function metaOfText(text) {
  return { res: resolutionOf(text), sub: subtitleOf(text), src: sourceOf(text) }
}

/** 元数据 → qB 标签（空值不写，标签越多越难在 qB 里看清） */
export function metaTagsOf(meta = {}) {
  const out = []
  if (meta.res) out.push(`res:${meta.res}`)
  if (meta.sub) out.push(`sub:${meta.sub}`)
  if (meta.src) out.push(`src:${meta.src}`)
  return out
}

/**
 * 从标签里读回元数据（历史种子没有这些标签 → 全空，交给名字兜底）
 * @param {string[]} tags
 */
export function metaFromTags(tags = []) {
  const pick = (prefix) => {
    for (const tag of tags) {
      if (String(tag).toLowerCase().startsWith(prefix)) return String(tag).slice(prefix.length).trim()
    }
    return ''
  }
  return { res: pick('res:'), sub: pick('sub:'), src: pick('src:') }
}

/**
 * 一条资源最终显示的「是什么货」
 * 标签优先（我们写进去的，改名也不丢），没有才解析名字 —— 两者都齐了就去重。
 * @param {{ res?: string, sub?: string, src?: string }} meta 已从标签读到的
 * @param {string} text 名字（种子名 + 文件名，用空格拼起来）
 * @param {number} [limit=3]
 * @returns {string[]} 如 `['1080P', '简日内嵌', 'WEB-DL']`
 */
export function releaseMetaTags(meta, text, limit = 3) {
  const fromName = metaOfText(text)
  const merged = [
    meta?.res || fromName.res,
    meta?.sub || fromName.sub,
    meta?.src || fromName.src,
  ]
  return [...new Set(merged.filter(Boolean))].slice(0, limit)
}
