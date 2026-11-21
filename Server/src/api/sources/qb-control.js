/**
 * qBittorrent 下载任务控制层 —— 暂停 / 继续 / 删除 / 改分类 / 换保存路径
 * ---------------------------------------------------------------------------
 * 为什么单独一个文件，而不塞进 `qb.js`：
 *   `qb.js` 管的是「读」（版本 / 传输 / 列表 / 加种 / 改名），而且带 4 秒列表缓存；
 *   下载页上的**控制按钮**要的是「写」，语义完全不同：
 *     · 写操作不该被列表缓存挡住（点完「暂停」马上拉列表必须是新状态）
 *     · 读失败可以退化成「暂无数据」，写失败必须让用户看见
 *     · 参数形状不一样（hashes 用 `|` 连接），写错了 qB 会**静默忽略，还回 200**
 *
 * 版本差异（本文件最需要小心的地方）：
 *   qB 4.x 只有 `pause` / `resume`，5.0 起改名为 `stop` / `start`（旧路径在新版本里
 *   直接 404）。这里**两个都试**：先打 pause/resume，只有 404 才补打 stop/start。
 *   顺序不能反 —— 4.x 上 stop/start 根本不存在，先打它们等于每次操作白扔一个 404；
 *   而 5.x 上先打旧名只多一次本机请求，代价可以忽略。
 *   这样同一个函数在 4.x / 5.x 上都能用，不用让用户在设置页里手选版本。
 *
 * 认证沿用 `transport/qb.js`（网关把 `Authorization: Bearer <key>` 认成登录态），
 * 不自己再写 fetch —— 重试、超时、日志都在那层。
 */
import { config } from '../../config.js'
import { fetchQbPost, getQbTorrentList } from './transport/qb.js'
import { fail } from '../../lib/errors.js'
import { logger } from '../../lib/logger.js'

const NOT_CONFIGURED = '还没配置 qBittorrent 的地址与 API Key（设置 → 下载）'
const UNREACHABLE = '连不上 qBittorrent（地址 / Key 不对，或服务没启动）'

/**
 * 配置齐了没有 —— 与 `qb.js` 的 `qbConfigured()` 同义。
 * 单独导出是为了让路由层在「没配」时直接关掉按钮，而不是点了才报错。
 */
export const qbControlReady = () => Boolean(config.qb?.base && config.qb?.apiKey)

/** 没配 → BAD_REQUEST（重试也不会好，得人去设置页填） */
function ensureConfigured() {
  if (!qbControlReady()) throw fail('BAD_REQUEST', NOT_CONFIGURED)
}

/* ── 接口路径（集中一处：qB 改路径时只改这里）────────────────────────────── */
const P = {
  pause: '/api/v2/torrents/pause',
  stop: '/api/v2/torrents/stop',
  resume: '/api/v2/torrents/resume',
  start: '/api/v2/torrents/start',
  delete: '/api/v2/torrents/delete',
  setCategory: '/api/v2/torrents/setCategory',
  setLocation: '/api/v2/torrents/setLocation',
}

/**
 * 状态码 → 中文（qB v4 与 v5 的**全部**取值）
 * ---------------------------------------------------------------------------
 * 为什么两套都留着：v4 用 `pausedUP/stalledDL`，v5 把这些拆成了 `stoppedUP` 与
 * `uploading+stalled` 这类带 `+` 的组合键（同一台 qB 里还可能混着，取决于种子何时加进来）。
 * 查不到的键一律回落「未知状态」，绝不把英文键名直接端到界面上。
 * 「stalled」不能只写「做种中 / 下载中」—— 它真正的意思是**没有对端、速度是 0**，
 * 用户看到「做种中」但速度 0 会以为坏了，所以文案要写明「无活动」。
 */
export const STATE_TEXT = Object.freeze({
  /* ── 异常 ── */
  error: '出错',
  missingFiles: '文件丢失',

  /* ── 做种 / 上传侧 ── */
  uploading: '做种中',
  'uploading+stalled': '做种中（无活动）',
  stalledUP: '做种中（无活动）',
  queuedUP: '排队做种',
  pausedUP: '已暂停',
  stoppedUP: '已暂停',
  checkingUP: '校验中',
  allocating: '分配空间',
  forciblyPausedUp: '强制暂停',

  /* ── 下载侧 ── */
  downloading: '下载中',
  'downloading+stalled': '下载中（无活动）',
  stalledDL: '下载中（无活动）',
  queuedDL: '排队下载',
  pausedDL: '已暂停',
  stoppedDL: '已暂停',
  checkingDL: '校验中',
  allocatingDL: '分配空间',
  metaDL: '获取元数据',
  forcedMetaDL: '获取元数据',
  forciblyPausedDL: '强制暂停',

  /* ── 其它 ── */
  moving: '移动文件中',
  unknown: '未知状态',
})

/** 大小写 / 空白的兜底索引：qB 偶尔大小写不一致，不该因此显示「未知」 */
const STATE_TEXT_LOWER = Object.freeze(
  Object.fromEntries(Object.entries(STATE_TEXT).map(([key, text]) => [key.toLowerCase(), text])),
)

/** 状态码 → 中文；认不出就「未知状态」 */
export function stateTextOf(state) {
  const key = String(state ?? '').trim()
  return STATE_TEXT[key] || STATE_TEXT_LOWER[key.toLowerCase()] || '未知状态'
}

/**
 * 剩余时间的哨兵值：qB 用 8640000（100 天）表示「算不出来 / 无限远」。
 * 直接显示成 8640000 秒等于骗人，这里的口径统一成 null。
 */
const ETA_INFINITE = 8640000

/** 秒 → 「1 小时 05 分」这种人话；null 用长破折号占位 */
export function formatEta(seconds) {
  if (seconds == null) return '—'
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n) => String(n).padStart(2, '0')
  if (h > 0) return `${h} 小时 ${pad(m)} 分`
  if (m > 0) return `${m} 分 ${pad(s)} 秒`
  return `${s} 秒`
}

/**
 * 一条原始种子 → 界面直接能用的形状（纯函数，验收直接喂数据）
 * ---------------------------------------------------------------------------
 * 只做「单位 + 缺省值」的翻译，不猜业务：
 *   · `size` 用 qB 的 `size`（本轮**已选中**的文件字节数）；老版本没有这个字段时退到 total_size
 *   · `added_on` 是**秒**级时间戳，前端 `new Date(ms)` 要毫秒，这里乘 1000
 *   · `eta` 的哨兵值收成 null（见 ETA_INFINITE）
 * @param {object} raw  /api/v2/torrents/info 的一项
 * @returns {{ hash: string, name: string, state: string, stateText: string, progress: number,
 *   size: number, downloaded: number, dlspeed: number, upspeed: number, eta: number|null,
 *   ratio: number, category: string, savePath: string, addedOn: number, etaText: string }}
 */
export function normTask(raw = {}) {
  const num = (value) => {
    const n = Number(value)
    return Number.isFinite(n) ? n : 0
  }
  const state = String(raw.state ?? '')

  // 进度夹到 0..1：qB 偶尔给 1.0000000001 / -0，别让进度条溢出
  const progress = Math.min(1, Math.max(0, num(raw.progress)))

  const rawEta = Number(raw.eta)
  const eta = Number.isFinite(rawEta) && rawEta > 0 && rawEta < ETA_INFINITE ? rawEta : null

  const addedOnSec = num(raw.added_on)

  return {
    hash: String(raw.hash ?? '').toLowerCase(),
    name: String(raw.name ?? ''),
    state,
    stateText: stateTextOf(state),
    progress,
    // `size` 缺失（v4 极老版本）时 total_size 才是「这个种子总共多大」
    size: num(raw.size) || num(raw.total_size),
    downloaded: num(raw.downloaded),
    dlspeed: num(raw.dlspeed),
    upspeed: num(raw.upspeed),
    eta,
    ratio: num(raw.ratio),
    category: String(raw.category ?? ''),
    savePath: String(raw.save_path ?? ''),
    addedOn: addedOnSec > 0 ? addedOnSec * 1000 : 0,
    etaText: formatEta(eta),
  }
}

/**
 * 种子列表（已归一）
 * ---------------------------------------------------------------------------
 * 不带缓存：这是「控制页」，用户点完暂停马上要看到新状态；
 * 4 秒的缓存会把刚做的操作吃掉（表现为「点了没反应」）。
 * @param {{ filter?: string }} [options] all / downloading / seeding / paused / active / inactive / stalled / errored …
 * @returns {Promise<Array<ReturnType<typeof normTask>>>}
 */
export async function listTasks({ filter = 'all' } = {}) {
  ensureConfigured()
  const list = await getQbTorrentList(config.qb.base, config.qb.apiKey, { filter: filter || 'all' }, 0)
  if (!Array.isArray(list)) throw fail('UPSTREAM', UNREACHABLE)
  return list.map(normTask)
}

/**
 * hashes 参数：qB 要的是 `a|b|c`，不是数组，也不是逗号。
 * 传数组进去 qB 会当成一个不存在的 hash —— **仍然回 200**，什么都不做。
 * @param {string[]|string} hashes
 * @returns {string}
 */
function joinHashes(hashes) {
  const list = (Array.isArray(hashes) ? hashes : [hashes])
    .flat()
    .map((h) => String(h ?? '').trim())
    .filter(Boolean)
  if (!list.length) throw fail('BAD_REQUEST', '没有指定任务')
  // 去重：同一批里重复点选很常见，qB 对重复 hash 是幂等的，但日志会难看
  return [...new Set(list)].join('|')
}

/** 失败时给人看的上下文：qB 的原话优先，其次是状态码 */
function failureHint(result) {
  const body = String(result.text ?? '').trim()
  if (body) return body.slice(0, 120)
  return result.status ? `HTTP ${result.status}` : '没有应答'
}

/**
 * 发一个写操作（不重试）
 * ---------------------------------------------------------------------------
 * 重试留给读；写操作重试会「成功一次失败一次」地放大副作用（比如删两次）。
 * 失败不直接抛 —— pause 需要看 404 才能决定要不要改用 stop。
 * @returns {Promise<{ ok: boolean, status: number, text: string }>}
 */
async function sendQbWrite(path, params, tip) {
  try {
    const text = await fetchQbPost(config.qb.base, path, params, config.qb.apiKey, tip, 0)
    return { ok: true, status: 200, text: String(text ?? '') }
  } catch (error) {
    return { ok: false, status: Number(error?.status) || 0, text: String(error?.bodyText || error?.message || '') }
  }
}

/**
 * 写操作 → 结论（统一错误码）
 * 404 = 这些 hash 在 qB 里已经没了（用户看到的列表是旧的）→ NOT_FOUND，别让人反复点
 */
function assertWrite(ok, result, label) {
  if (ok) return { ok: true }
  if (result.status === 404) throw fail('NOT_FOUND', `qB 里找不到这些任务（${label}没有生效）`)
  throw fail('UPSTREAM', `qB ${label}失败：${failureHint(result)}`)
}

/**
 * 旧路径 → 新路径的兜底（pause/stop、resume/start）
 * 只在旧路径 **404** 时补打新路径；其它错误（401/500）直接报，别把真错误掩盖成「版本问题」。
 */
async function sendWithFallback(primary, fallback, params, tip) {
  const first = await sendQbWrite(primary, params, tip)
  if (first.ok || first.status !== 404) return { result: first, usedPath: primary }
  logger.debug({ primary, fallback }, 'qb.control fallback to new api name')
  const second = await sendQbWrite(fallback, params, tip)
  return { result: second, usedPath: fallback }
}

/**
 * 暂停 / 停止
 * @param {string[]} hashes
 * @returns {Promise<{ ok: true, count: number }>}
 */
export async function pauseTasks(hashes = []) {
  ensureConfigured()
  const joined = joinHashes(hashes)
  const count = joined.split('|').length

  const { result, usedPath } = await sendWithFallback(P.pause, P.stop, { hashes: joined }, 'QbPauseTorrents')
  assertWrite(result.ok, result, '暂停')
  logger.info({ count, path: usedPath }, 'qb.control pause done')
  return { ok: true, count }
}

/**
 * 继续 / 开始
 * @param {string[]} hashes
 * @returns {Promise<{ ok: true, count: number }>}
 */
export async function resumeTasks(hashes = []) {
  ensureConfigured()
  const joined = joinHashes(hashes)
  const count = joined.split('|').length

  const { result, usedPath } = await sendWithFallback(P.resume, P.start, { hashes: joined }, 'QbResumeTorrents')
  assertWrite(result.ok, result, '继续')
  logger.info({ count, path: usedPath }, 'qb.control resume done')
  return { ok: true, count }
}

/**
 * 删除任务
 * ---------------------------------------------------------------------------
 * `deleteFiles` 一定是**显式**发出去的字符串 `true`/`false`：不传时 qB 的默认值
 * 在不同版本里不一样，而「删种顺手删了 40G 数据」是不可逆的 —— 不能靠默认值。
 * @param {{ hashes?: string[], deleteFiles?: boolean }} [options]
 * @returns {Promise<{ ok: true, count: number, deleteFiles: boolean }>}
 */
export async function deleteTasks({ hashes = [], deleteFiles = false } = {}) {
  ensureConfigured()
  const joined = joinHashes(hashes)
  const count = joined.split('|').length

  const result = await sendQbWrite(
    P.delete,
    { hashes: joined, deleteFiles: deleteFiles ? 'true' : 'false' },
    'QbDeleteTorrents',
  )
  assertWrite(result.ok, result, '删除')
  logger.info({ count, deleteFiles: Boolean(deleteFiles) }, 'qb.control delete done')
  return { ok: true, count, deleteFiles: Boolean(deleteFiles) }
}

/**
 * 改分类（空串 = 移出分类，qB 支持；所以只校验 hashes）
 * @param {string[]} hashes
 * @param {string} category
 */
export async function setCategory(hashes = [], category = '') {
  ensureConfigured()
  const joined = joinHashes(hashes)
  const result = await sendQbWrite(
    P.setCategory,
    { hashes: joined, category: String(category ?? '') },
    'QbSetCategory',
  )
  assertWrite(result.ok, result, '修改分类')
  logger.info({ count: joined.split('|').length, category }, 'qb.control set-category done')
  return { ok: true }
}

/**
 * 换保存路径（qB 会把数据搬过去，大种子要等一会儿）
 * @param {string[]} hashes
 * @param {string} location 目标目录（绝对路径）
 */
export async function setLocation(hashes = [], location = '') {
  ensureConfigured()
  const joined = joinHashes(hashes)
  const target = String(location ?? '').trim()
  if (!target) throw fail('BAD_REQUEST', '缺少目标保存路径')

  const result = await sendQbWrite(P.setLocation, { hashes: joined, location: target }, 'QbSetLocation')
  assertWrite(result.ok, result, '修改保存路径')
  logger.info({ count: joined.split('|').length, location: target }, 'qb.control set-location done')
  return { ok: true }
}

/**
 * 缓存失效钩子
 * ---------------------------------------------------------------------------
 * 控制层本身**不缓存**任何东西（每次都是现打 qB），所以这里是空实现。
 * 保留导出的原因：写操作之后列表可能已经变了，调用方（路由层）可以在这里挂上
 * `qb.js` 的列表缓存失效 —— 那属于 `qb.js` 的职责，本文件不去动它的私有缓存。
 */
export function clearQbCache() {
  /* 无缓存可清：listTasks 每次都读上游 */
  return 0
}
