/**
 * 时长换算与展示
 * ---------------------------------------------------------------------------
 * 配置里的时长都以**毫秒**为基准存储（跨语言、跨库都好处理），
 * 但界面不该要求用户心算「1800000 ms 是多久」——这里负责两个方向的换算：
 *   · formatDuration：基准值 → 可读文案（`30 分钟` / `7 天`）
 *   · toMilliseconds / fromMilliseconds：配合单位下拉做换算
 * 只处理整数毫秒；非法输入返回空串（界面据此回落成原始数字，不显示 "NaN"）。
 */

/**
 * 单位 → 换算到毫秒的倍数
 * ---------------------------------------------------------------------------
 * **英文缩写与中文都要认**（`m` 与 `分钟` 是同一个单位）：
 * 单位下拉里用的是缩写（`ms/s/m/h/d`，见 FieldControl 的 UNITS），
 * 而字段声明、用户手输用的是中文（`毫秒/秒/分钟`）。
 * 以前这里只有中文 + `ms`，于是 `fromMilliseconds(60000, 'm')` 找不到倍数、
 * 按 1 算 → 行外显示「60000 m」而弹层里是「1」—— 里外自相矛盾。
 */
const FACTOR = {
  ms: 1,
  毫秒: 1,
  s: 1000,
  秒: 1000,
  m: 60 * 1000,
  分: 60 * 1000,
  分钟: 60 * 1000,
  h: 60 * 60 * 1000,
  时: 60 * 60 * 1000,
  小时: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  天: 24 * 60 * 60 * 1000,
}

export const DURATION_UNITS = ['ms', '秒', '分钟', '小时', '天']

/** 数值（按给定单位）+ 单位 → 毫秒 */
export function toMilliseconds(value, unit = 'ms') {
  const n = Number(value)
  const factor = FACTOR[unit] ?? 1
  if (!Number.isFinite(n)) return null
  return Math.round(n * factor)
}

/** 毫秒 → 按目标单位表示的数值（保留 2 位小数，去掉多余的 0） */
export function fromMilliseconds(ms, unit = 'ms') {
  const factor = FACTOR[unit] ?? 1
  if (!Number.isFinite(Number(ms))) return null
  return Number((Number(ms) / factor).toFixed(2))
}

/**
 * 毫秒 → 紧凑人话：`500ms` / `30s` / `1s 500ms` / `5m 30s` / `2h` / `7d`
 * ---------------------------------------------------------------------------
 * 为什么不是「30 分钟」「7 天」：这些值都要填回输入框、要能加减着调，
 * 用 s/ms/m/h/d 的写法既短又能直接对照输入（用户按这个习惯读间隔与超时）。
 * 最多给两级单位：`1d 12h` 比 `36h` 好读，`1d 12h 30m 15s` 就啰嗦了。
 */
export function formatDuration(value, unit = 'ms') {
  const ms = toMilliseconds(value, unit)
  if (ms === null || ms < 0) return ''
  if (ms === 0) return '0ms'

  const units = [
    { label: 'd', size: 24 * 60 * 60 * 1000 },
    { label: 'h', size: 60 * 60 * 1000 },
    { label: 'm', size: 60 * 1000 },
    { label: 's', size: 1000 },
    { label: 'ms', size: 1 },
  ]

  let rest = ms
  const parts = []
  for (const { label, size } of units) {
    const n = Math.floor(rest / size)
    if (!n) continue
    parts.push(`${n}${label}`)
    rest -= n * size
    if (parts.length === 2) break
  }
  return parts.join(' ')
}

/* ── 直接写带单位的输入 ────────────────────────────────────────────────────
   为什么要：字段基准是毫秒，但让人写「10000」再自己换算成 10 秒，是把机器该干的活
   推给人。输入框允许直接写 `10s` / `1.5m` / `2h` / `500ms` / `10分钟`，
   也允许小数（`10.5s`）；不带单位就按字段基准（毫秒）理解。 */

/** 单位写法 → 毫秒倍数（英文缩写与中文都认） */
const UNIT_ALIAS = [
  [/^(ms|millis|millisecond|milliseconds|毫秒)$/i, 1],
  [/^(s|sec|secs|second|seconds|秒)$/i, 1000],
  [/^(m|min|mins|minute|minutes|分|分钟)$/i, 60 * 1000],
  [/^(h|hr|hrs|hour|hours|时|小时)$/i, 60 * 60 * 1000],
  [/^(d|day|days|天)$/i, 24 * 60 * 60 * 1000],
]

/**
 * 带单位的时长输入 → 毫秒
 * ---------------------------------------------------------------------------
 * **界面显示成什么样，输入框就能照着填什么样**（这条是刻意的：显示 `1m 30s`、
 * 输入却要求换算成 `90000`，是把机器该干的活推给人）。
 * 支持：
 *   · 单个单位：`10s` / `1.5m` / `2h` / `500ms` / `10分钟`
 *   · 复合写法：`1d 12h` / `1m 30s` / `1h 30m 5s`
 *   · 不带单位：按 `base` 换算（默认 1 = 毫秒）
 * @param {string|number} text
 * @param {number} [base] 不带单位时的基准倍数
 * @returns {number|null} 解析失败返回 null（界面据此回滚，不发非法值给后端）
 */
export function parseDuration(text, base = 1) {
  const raw = String(text ?? '').trim()
  if (!raw) return null

  // 纯数字：按基准倍数理解
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) {
    const value = Number(raw)
    if (!Number.isFinite(value) || value < 0) return null
    return Math.round(value * base)
  }

  // 一个或多个「数字 + 单位」片段，全部必须是合法单位
  const parts = raw.match(/\d+(?:\.\d+)?\s*[a-zA-Z\u4e00-\u9fa5]+/g)
  if (!parts || parts.join('').replace(/\s/g, '').length !== raw.replace(/\s/g, '').length) return null

  let total = 0
  for (const part of parts) {
    const hit = part.match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z\u4e00-\u9fa5]+)$/)
    if (!hit) return null
    const value = Number(hit[1])
    if (!Number.isFinite(value) || value < 0) return null
    const unit = UNIT_ALIAS.find(([re]) => re.test(hit[2]))
    if (!unit) return null
    total += value * unit[1]
  }
  return Math.round(total)
}

/**
 * 毫秒 → 输入框里的紧凑写法（能整除就用大单位：10000 → `10s`、5400000 → `1.5h`）
 * @param {number} ms
 */
export function durationInput(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n < 0) return ''
  if (n === 0) return '0'
  if (n % 86400000 === 0) return `${n / 86400000}d`
  if (n % 3600000 === 0) return `${n / 3600000}h`
  if (n % 60000 === 0) return `${n / 60000}m`
  if (n % 1000 === 0) return `${n / 1000}s`
  return `${n}ms`
}

/* ── 显示单位：行外 / 弹层 / 步进提示**共用同一套规则** ───────────────────
   为什么必须抽成纯函数放这里：以前三处各写一份换算，于是出现
   「点进去是 1s、外面却显示 60000m」这种自相矛盾的界面。
   规则只有一条：**能整除就用最大的单位**，除不尽就退回毫秒。 */

/** 单位档位（从大到小） */
const DISPLAY_UNITS = [
  { unit: 'd', ms: 86400000 },
  { unit: 'h', ms: 3600000 },
  { unit: 'm', ms: 60000 },
  { unit: 's', ms: 1000 },
  { unit: 'ms', ms: 1 },
]

/**
 * 给一个毫秒值挑显示单位
 * @param {number} value 毫秒
 * @param {string} [fallback] 0 / 非法值时的退路（用字段声明的单位）
 * @returns {string} 'd' | 'h' | 'm' | 's' | 'ms'
 * @example unitForMs(350) === 'ms'   // 350 不能整秒，就用毫秒
 * @example unitForMs(60000) === 'm'  // 一整分钟，用分钟
 */
export function unitForMs(value, fallback = 'ms') {
  const n = Number(value)
  if (!Number.isFinite(n) || n === 0) return fallback
  const abs = Math.abs(n)
  for (const { unit, ms } of DISPLAY_UNITS) {
    if (abs % ms === 0) return unit
  }
  return 'ms'
}

/**
 * 毫秒 → 指定单位下的数字字符串（唯一一份换算，界面各处都用它）
 * @example toDisplayText(60000, 'm') === '1'
 * @example toDisplayText(350, 'ms') === '350'
 */
export function toDisplayText(value, unit = 'ms') {
  const n = fromMilliseconds(value, unit)
  return n === null ? '' : String(n)
}
