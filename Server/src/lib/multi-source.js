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

  const start = Math.min(Math.max(preferred[kind] || 0, 0), bases.length - 1)
  const order = [...bases.slice(start), ...bases.slice(0, start)]
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
