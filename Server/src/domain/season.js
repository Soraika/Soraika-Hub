/**
 * 季度工具 —— 与 Web/src/utils/season.js 保持同一套约定
 * ---------------------------------------------------------------------------
 * 冬 1~3 月 / 春 4~6 月 / 夏 7~9 月 / 秋 10~12 月（日本新番季）
 * 「季选」的 years 形状由后端直接下发（前端注释里定的），所以这里必须和前端
 * 算得完全一致：倒序、2012 ~ 今年、未来季进 disabled。
 */

export const SEASONS = ['冬', '春', '夏', '秋']
export const SEASON_START_MONTH = { 冬: 1, 春: 4, 夏: 7, 秋: 10 }
/** 年份起点（与旧版一致） */
export const MIN_YEAR = 2012

/** 当前季：{ year, season } */
export function currentSeason(now = new Date()) {
  const month = now.getMonth() + 1
  const season = SEASONS.find((s) => month >= SEASON_START_MONTH[s] && month < SEASON_START_MONTH[s] + 3)
  return { year: now.getFullYear(), season: season || '冬' }
}

/** 放送日期（YYYY-MM-DD）落在哪一季 */
export function seasonOf(dateStr) {
  const month = Number(String(dateStr || '').slice(5, 7))
  if (!month) return ''
  return SEASONS.find((s) => month >= SEASON_START_MONTH[s] && month < SEASON_START_MONTH[s] + 3) || ''
}

/** 某年某季是否尚未到来（未来季 → 前端应禁用） */
export function isFutureSeason(year, season, now = new Date()) {
  const y = Number(year)
  if (!Number.isFinite(y)) return true
  if (y > now.getFullYear()) return true
  if (y < now.getFullYear()) return false
  const startMonth = SEASON_START_MONTH[season]
  if (!startMonth) return false
  return now.getMonth() + 1 < startMonth
}

/** SeasonPicker 直接可用的年份选项：倒序、2012 ~ 今年、未来季进 disabled */
export function buildYearOptions({ from = MIN_YEAR, to, now = new Date() } = {}) {
  const endYear = to ?? now.getFullYear()
  const list = []
  for (let y = endYear; y >= Math.min(from, endYear); y--) {
    list.push({ year: y, disabled: SEASONS.filter((s) => isFutureSeason(y, s, now)) })
  }
  return list
}
