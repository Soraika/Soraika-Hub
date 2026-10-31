/**
 * 从资源文件名里摘「判断这集值不值得下」的短标签
 * ---------------------------------------------------------------------------
 * 用途：已下载列表一条只留三件事 —— 第几集 / 这集是什么货 / 现在什么状态。
 * 「是什么货」= 画质、字幕、片源。这三样在文件名里几乎总是以方括号或短词出现：
 *   `[Nekomoe kissaten][Kimi ga Shinu made][12][1080p][JPSC]`
 *   `[Sakurato] Guilty Hole [06][AVC-8bit 1080p AAC][CHS]`
 *   `相反的你和我 S02E23.mp4`（改过名的：**什么标签都没有**，那就什么都不显示）
 *
 * 刻意不做的事：
 *   · 不猜字幕组（那是列表第一级已经分好的维度）
 *   · 不解析编码细节（AVC / HEVC 谁更好跟「这集对不对」无关）
 *   · 认不出就返回空数组 —— 界面上宁可不显示，也不摆一个「未知」
 */

/** 画质：`1080p` 这类标准写法，以及 `1920x1080` 这种宽高写法（旧资源常见） */
const RES_RE = /\b(4320p|2160p|1080p|720p|480p|360p|4k|8k)\b/i
const WH_RE = /\b(\d{3,4})\s*[xX×]\s*(\d{3,4})\b/
/** 宽高 → 习惯叫法（认不出就按高度写 `NNNP`） */
const RES_BY_WH = { '3840x2160': '2160P', '1920x1080': '1080P', '1280x720': '720P', '720x480': '480P' }
/** 字幕：中文/日文标记优先（这是国内资源最常用来区分的），其次英文缩写 */
const SUB_RE = /(简繁|简日|繁日|简中|繁中|简体|繁体|内嵌|内封|外挂|双语|CHS|CHT|GB|BIG5|JPSC|JPTC|JPCH|JPN)/i
/** 片源 */
const SRC_RE = /\b(WEB-?DL|WEB-?Rip|BluRay|BDRip|BD|HDTV|DVDRip)\b/i
/** 编码（只保留最常见的三种，用来区分同集的两个版本） */
const CODEC_RE = /\b(HEVC|H\.?265|x265|AVC|H\.?264|x264|AV1)\b/i

/** 规范化：大写、去掉多余空格与点号（`web-dl` → `WEB-DL`） */
const norm = (s) =>
  String(s)
    .replace(/\.(?=\d)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()

const pick = (text, re) => {
  const hit = text.match(re)
  if (!hit) return ''
  return norm(hit[1])
}

/** 画质：先认 `1080p`，再认 `1920x1080`（两种写法在不同年代的资源里都常见） */
function resolutionOf(text) {
  const std = pick(text, RES_RE)
  if (std) return std
  const wh = text.match(WH_RE)
  if (!wh) return ''
  return RES_BY_WH[`${wh[1]}x${wh[2]}`] || `${wh[2]}P`
}

/**
 * @param {string} name 文件名（改过名后的优先，退回种子名）
 * @param {number} [limit=3] 最多返回几个
 * @returns {string[]} 如 `['1080P', '简日内嵌', 'WEB-DL']`
 */
export function fileTagsOf(name, limit = 3) {
  const text = String(name || '')
  if (!text) return []

  const out = []
  const push = (value) => {
    if (!value || out.includes(value)) return
    out.push(value)
  }

  // 顺序按「看这集时先关心什么」：画质 → 字幕 → 片源 → 编码
  push(resolutionOf(text))
  push(pick(text, SUB_RE))
  push(pick(text, SRC_RE))
  push(pick(text, CODEC_RE))

  return out.slice(0, limit)
}
