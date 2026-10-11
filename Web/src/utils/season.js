/**
 * 季度（新番季）工具 —— 纯函数，无依赖、无副作用
 * ---------------------------------------------------------------------------
 * 只做两件事：
 *   1. buildYearList / buildYearOptions：生成年份选项（区间由使用方给出，如 2012~今年）
 *   2. isFutureSeason：判断某年某季「尚未到来」（用于禁用未来季）
 * 约定（与旧版一致，日本新番季划分）：冬 1~3 月 / 春 4~6 月 / 夏 7~9 月 / 秋 10~12 月
 * 说明：组件本身不判断日期 —— 禁用状态由数据（disabled 数组）驱动；
 *       若后端不直接下发 disabled，就用这里的函数在页面里算。
 */

export const SEASONS = ['冬', '春', '夏', '秋']

/** 每季起始月份，用于判断「未来季」 */
export const SEASON_START_MONTH = { 冬: 1, 春: 4, 夏: 7, 秋: 10 }

/**
 * 生成年份数组
 * @param {{from?: number, to?: number, order?: 'desc'|'asc'}} options
 *        from / to 均含端点；order 默认 'desc'（新的在前，符合下拉列表习惯）
 * @returns {number[]}
 */
export function buildYearList({ from = 2012, to = new Date().getFullYear(), order = 'desc' } = {}) {
  const start = Math.min(Number(from), Number(to))
  const end = Math.max(Number(from), Number(to))
  const list = []
  for (let y = start; y <= end; y++) list.push(y)
  return order === 'asc' ? list : list.reverse()
}

/**
 * 某年某季是否尚未到来（未来季 → 应禁用）
 * @param {number|string} year
 * @param {string} season
 * @param {Date} now 便于测试注入
 */
export function isFutureSeason(year, season, now = new Date()) {
  const y = Number(year)
  if (!Number.isFinite(y)) return true
  const nowYear = now.getFullYear()
  if (y > nowYear) return true
  if (y < nowYear) return false
  const startMonth = SEASON_START_MONTH[season]
  if (!startMonth) return false // 未知季度不做「未来」判断
  return now.getMonth() + 1 < startMonth
}

/** 当前季（同一套划分规则），返回 { year, season } */
export function currentSeason(now = new Date()) {
  const month = now.getMonth() + 1
  const season = SEASONS.find((s) => month >= SEASON_START_MONTH[s] && month < SEASON_START_MONTH[s] + 3)
  return { year: now.getFullYear(), season: season || '冬' }
}

/**
 * 直接产出 SeasonPicker 需要的 years 形状：[{ year, disabled: ['秋', ...] }]
 * 后端若不提供 disabled，可用这个函数兜底。
 */
export function buildYearOptions(options = {}) {
  const now = options.now || new Date()
  return buildYearList({ ...options, to: options.to ?? now.getFullYear() }).map((year) => ({
    year,
    disabled: SEASONS.filter((season) => isFutureSeason(year, season, now)),
  }))
}
