/**
 * 星期显示顺序（纯函数，无依赖、无副作用）
 * ---------------------------------------------------------------------------
 * 首页排期区与星期地铁图共用同一份顺序：
 *   改顺序 = 改 buildWeekOrder(mode, today) 的两个入参，别处不需要动。
 * 约定：day 取值 0 = 周日 … 6 = 周六（与 JS Date.getDay() 一致）。
 * 说明：这里只产出「顺序数组」，不关心数据从哪来（后端接口 / 设置项 / 本地存储都可）。
 */

/** 顺序策略（后期由设置页或后端下发，页面只认这里的值） */
export const WEEK_ORDER_MODES = {
  /** 以今天为首（默认，最常用）：今天周三 → 周三 周四 周五 周六 周日 周一 周二 */
  TODAY_FIRST: 'today-first',
  /** 固定周日为首（旧版行为）：周日 周一 周二 周三 周四 周五 周六 */
  SUNDAY_FIRST: 'sunday-first',
  /** 周一为首：周一 周二 周三 周四 周五 周六 周日 */
  MONDAY_FIRST: 'monday-first',
}

/** 区块标题用的全称，下标 = day */
export const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 地铁站 / 卡片徽标用的单字，下标 = day */
export const WEEKDAY_SHORTS = ['日', '一', '二', '三', '四', '五', '六']

/** 「今天」标识文案 */
export const TODAY_LABEL = '今天'

/** 把任意输入收敛到 0~6（越界环绕、非数字退回周日） */
export function normalizeWeekday(day) {
  const n = Number(day)
  if (!Number.isFinite(n)) return 0
  return ((Math.trunc(n) % 7) + 7) % 7
}

/**
 * 生成星期顺序
 * @param {string} mode  WEEK_ORDER_MODES 之一（未知值按 TODAY_FIRST 处理）
 * @param {number} today 0~6，仅 TODAY_FIRST 用到
 * @returns {number[]} 长度恒为 7 的顺序数组（无重复、无缺失）
 */
export function buildWeekOrder(mode = WEEK_ORDER_MODES.TODAY_FIRST, today = 0) {
  if (mode === WEEK_ORDER_MODES.MONDAY_FIRST) return [1, 2, 3, 4, 5, 6, 0]
  if (mode === WEEK_ORDER_MODES.SUNDAY_FIRST) return [0, 1, 2, 3, 4, 5, 6]

  // TODAY_FIRST：从今天开始环绕（今天 → 明天 → … → 昨天）
  const start = normalizeWeekday(today)
  return Array.from({ length: 7 }, (_, i) => (start + i) % 7)
}
