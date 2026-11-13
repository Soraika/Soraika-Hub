/**
 * 详情 DTO 映射 —— anime 行 → 侧边详情面板可直接摆的数据
 * ---------------------------------------------------------------------------
 * 与首页卡片（api/mappers/home.js）同一套约定：文案在后端拼好，前端不格式化。
 * 差异只在「卡片要一行摘要、面板要整份档案」，所以这里是独立映射而不是复用 toCardItem。
 * poster 同样走统一出图入口：/api/img/anime/{id}（缓存 / 防盗链 / 换源都在后端）。
 */
import { config } from './../../config.js'
import { DAY_META, compactNumber, parseTags, posterUrlOf, ratingText, scoreText, themeTags } from './../../lib/format.js'
import { primaryBase } from './../../lib/multi-source.js'
import { seasonOf } from './../../domain/season.js'

/**
 * 放送季文案：`2026 夏`
 * ---------------------------------------------------------------------------
 * 两个来源，缺一不可：
 *   ① 排期字段（year + season）—— Mikan 季度页给的最准
 *   ② 首播日期（air_date）—— 扫描进来的老番 / 系列里的骨架行**没有排期字段**，
 *      但它们有 Bangumi 的首播日期，能推出「2004 秋」
 * 都没有 → 返回 ''（前端那一行不渲染）。**不能只认 ①**：否则从系列里点进老番/剧场版，
 * 「放送」这一行会整行消失。
 */
function seasonTextOf(row) {
  const year = Number(row.year) || Number(String(row.air_date || '').slice(0, 4)) || 0
  if (!year) return ''
  const season = row.season || seasonOf(row.air_date)
  return `${year} ${season || ''}`.trim()
}

/**
 * 一行 anime 记录 → 详情面板数据
 * 拿不到的字段一律给空值（'' / null / []），**不给 undefined** —— 前端 v-if 判断更省事。
 */
export function toAnimeDetail(row) {
  const total = Number(row.rating_total) || 0
  const hasScore = row.score != null && total > 0
  const watching = Number(row.watching) || 0

  // 主标题优先 BGM 中文名；没有再退回 Mikan 标题、BGM 原名
  const title = row.title_bgm || row.title_mikan || row.title_bgm_origin || ''
  const titleOriginal = row.title_bgm_origin && row.title_bgm_origin !== title ? row.title_bgm_origin : ''

  // 标签区与卡片信息行同口径：只给题材（TV / 日本这类平台地域标签剔掉）；
  // 整部作品只有平台类标签时（极少数）才退回原始标签，免得标签区空着
  const rawTags = parseTags(row.tags)
  const themes = themeTags(rawTags, 8)

  return {
    id: row.id,
    title,
    titleOriginal,
    poster: posterUrlOf(row),
    score: hasScore ? row.score : null,
    scoreText: hasScore ? scoreText(row.score) : '',
    ratingText: hasScore ? ratingText(total) : '',
    watchingText: watching > 0 ? `${compactNumber(watching)}人在看` : '',
    epsText: row.total_episodes ? `${row.total_episodes} 话` : '',
    // 放送季：优先用排期字段（Mikan 给的年+季）；没有（扫描行 / 骨架行）就用首播日期推
    // —— 否则从系列里点进一部老番/剧场版，这一行会整行消失（用户看到「放送」不见了）
    seasonText: seasonTextOf(row),
    weekdayText: DAY_META[row.weekday]?.dayLabel ?? '',
    airDate: row.air_date || '',
    tags: themes.length ? themes : rawTags.slice(0, 8),
    summary: row.summary || '',
    bgmId: row.bgm_id,
    mikanId: row.mikan_id,
    /** 外链也在这里拼好：前端只认成品 URL，不拼站点地址 */
    bgmUrl: row.bgm_id ? `https://bgm.tv/subject/${row.bgm_id}` : '',
    mikanUrl: row.mikan_id ? `${primaryBase('mikan')}/Home/Bangumi/${row.mikan_id}` : '',
  }
}

/**
 * Mikan 详情页解析出来的字幕组 → 前端条目
 * ---------------------------------------------------------------------------
 * `id` 直接用**该作品下的 RSS id**：它就是「这部作品里的这个组」的稳定身份，
 * 也是取资源列表唯一需要的参数 —— 前端回传它即可，服务端不再存那份映射。
 */
export function toSubgroupItem(sg) {
  const rssId = sg?.subgroupRSSId == null ? '' : String(sg.subgroupRSSId)
  return {
    id: Number(rssId) || 0,
    name: sg?.subgroupName || '',
    mikanId: sg?.subgroupMikanId == null ? '' : String(sg.subgroupMikanId),
    rssId,
  }
}
