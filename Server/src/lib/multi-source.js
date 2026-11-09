/**
 * 多源地址与故障切换 —— 「Mikan / Bangumi 写死一个地址」这件事的解法
 * ---------------------------------------------------------------------------
 * 需求：同一份数据有多个可用入口（镜像、备用域名），任何一个抽风都不该让整个功能停摆。
 *
 * 做法（刻意做得简单）：
 *   · `config.<kind>.bases` 是**有序候选**；
 *   · 依次尝试，**第一个成功**的立即返回；失败只记一条 warn，继续试下一个；
 *   · 记住上次成功的那条（`preferred`），下次从它开始 —— 避免每次都先撞一遍坏地址；
 *   · 全部失败 → 抛**第一个**错误（它的语义最贴近"这次真的没拿到"，比如 404 仍是 404）。
 *
 * 为什么不做「健康检查 + 主动摘除」：这是个单机小服务，请求量很低，
 * 顺序尝试 + 记忆已经够用；主动摘除反而会引入"摘错了再也回不来"的状态。
 */
import { config } from '../config.js'
import { fail } from './errors.js'
import { logger } from './logger.js'

/** 上次成功的下标（进程内记忆，重启即重置） */
const preferred = { mikan: 0, bgm: 0 }

/** 延迟探测结果的缓存（每个源一份；`sources.pickFastest` 关掉时不用它） */
const probed = { mikan: { at: 0, bases: [] }, bgm: { at: 0, bases: [] } }

/**
 * 探测一个地址的「首字节延迟」（毫秒）；失败返回 null
 * ---------------------------------------------------------------------------
 * 只发一个 2 字节的 Range 请求就把 body 取消掉 —— 我们只想知道"多久能连上"，
 * 不想为一个探测真把页面下载下来。5xx 与网络错误都算失败；
 * 4xx 仍然算"通"（说明域名在、只是路径不对），延迟有效。
 */
export async function probeMs(url, { timeoutMs = 2000, range = 'bytes=0-1' } = {}) {
  const started = process.hrtime.bigint()
  try {
    const res = await fetch(url, { headers: { Range: range }, signal: AbortSignal.timeout(timeoutMs) })
    try {
      await res.body?.cancel()
    } catch {
      /* body 可能已经空了 */
    }
    if (res.status >= 500) return null
    return Number(process.hrtime.bigint() - started) / 1e6
  } catch {
    return null
  }
}

/**
 * 按延迟排序的候选地址（只在 `sources.pickFastest` 打开、且候选 ≥ 2 时才探测）
 * ---------------------------------------------------------------------------
 * **不阻塞请求**：有缓存就用缓存；没有就先按列表顺序返回，同时后台探一轮
 * （探测最长 2 秒，挡在首页请求前面的话，第一次打开会白等 2 秒）。
 * 探测失败的地址**不丢弃**，只是排到最后 —— 探测失败不等于真的不能用
 * （有些 CDN 会挡掉带 Range 的探测请求）。
 * @param {'mikan'|'bgm'} kind
 * @param {{ log?: object, wait?: boolean }} [options] `wait: true` = 这次就等探测结果（脚本/测试用）
 */
export async function rankedBases(kind, { log = logger, wait = false } = {}) {
  const bases = basesOf(kind)
  if (!config.sources?.pickFastest || bases.length < 2) return bases

  const cache = probed[kind]
  const ttl = Number(config.sources?.probeTtlMs) || 10 * 60 * 1000
  if (cache.bases.length === bases.length && Date.now() - cache.at < ttl) return cache.bases

  const task = (async () => {
    const timed = await Promise.all(bases.map(async (base) => ({ base, ms: await probeMs(base) })))
    const alive = timed.filter((item) => item.ms !== null).sort((a, b) => a.ms - b.ms).map((item) => item.base)
    const out = [...alive, ...bases.filter((base) => !alive.includes(base))]
    probed[kind] = { at: Date.now(), bases: out }
    log.info(
      {
        kind,
        order: timed.map((item) => `${item.base}=${item.ms === null ? 'fail' : `${Math.round(item.ms)}ms`}`),
      },
      'source.probe ranked',
    )
    return out
  })().catch(() => bases)

  if (!wait) {
    void task // 后台测速，这次先用列表顺序
    return bases
  }
  return task
}

/**
 * 某个源的候选地址（去掉空项）
 * @param {'mikan'|'bgm'} kind
 * @returns {string[]}
 */
export function basesOf(kind) {
  const list = kind === 'bgm' ? config.bgm?.bases : config.mikan?.bases
  return (Array.isArray(list) ? list : []).map((s) => String(s || '').trim()).filter(Boolean)
}

/** 展示 / 外链用的固定地址：**始终是第一个**（链接不能跟着健康检查漂移） */
export function primaryBase(kind) {
  return basesOf(kind)[0] || ''
}

/**
 * 依次尝试候选地址
 * @template T
 * @param {'mikan'|'bgm'} kind
 * @param {(base: string) => Promise<T>} attempt 用某个地址做一次完整请求
 * @param {{ log?: object, tip?: string }} [opts]
 * @returns {Promise<T>}
 */
export async function tryBases(kind, attempt, { log = logger, tip = kind } = {}) {
  const bases = basesOf(kind)
  if (!bases.length) {
    throw fail('INTERNAL', `${kind} 没有配置任何可用地址（设置页里至少要留一条）`)
  }

  // 竞速模式：按探测出的延迟顺序；否则沿用"上次成功的那个开头"的轮转
  let order = bases
  if (config.sources?.pickFastest) {
    order = await rankedBases(kind, { log })
  } else {
    const start = Math.min(Math.max(preferred[kind] || 0, 0), bases.length - 1)
    order = [...bases.slice(start), ...bases.slice(0, start)]
  }
  let firstError

  for (const base of order) {
    try {
      const result = await attempt(base)
      const index = bases.indexOf(base)
      if (index >= 0 && index !== preferred[kind]) {
        preferred[kind] = index
        log.info({ kind, base, index }, 'source.switch ok')
      }
      return result
    } catch (err) {
      firstError ||= err
      // 只有当**还有下一个候选**时才值得记一条（否则下面会抛出去，调用方自己会记）
      if (order[order.length - 1] !== base) {
        log.warn({ kind, base, err: err?.message || String(err) }, `source.${tip} fail try-next`)
      }
    }
  }

  throw firstError
}

/** 看板用：当前首选哪个地址 */
export function sourceState() {
  return {
    mikan: { preferred: basesOf('mikan')[preferred.mikan] || '', count: basesOf('mikan').length },
    bgm: { preferred: basesOf('bgm')[preferred.bgm] || '', count: basesOf('bgm').length },
  }
}
