/**
 * 离线 dump 更新任务 —— 「自动（每天到点）」与「手动（设置页按钮）」共用一份状态
 * ---------------------------------------------------------------------------
 * 为什么不各写一套：**同一时刻只能有一次更新**。下载 450MB + 整表重灌 SQLite，
 * 两个并发跑会互相踩（.part 文件、bgm_relation 清空后又被另一趟写）。
 * 所以状态与互斥都收在这里，worker 与路由都只调 `startDumpUpdate()`。
 *
 * 状态是**内存**的（进程重启就归零）——这是有意的：
 *   · 「上次导入的是哪一版」有持久记录（`dump_state.digest`），重启不会重复导；
 *   · 但「这一趟跑到 37% 了」这种瞬时进度没必要落库，重启后本来也没有这一趟。
 *
 * phase 取值：
 *   idle       没有在跑（result/lastError 里是**上一次**的结果）
 *   checking   正在查索引（几百字节，通常 <1s）
 *   downloading 正在下载（progress 有意义）
 *   importing  下载完，正在流式导入（7s 左右，progress 不再更新）
 *   done / failed
 */
import { updateDump } from './dump-update.js'

const state = {
  /** 谁触发的：manual（设置页按钮）/ auto（每日检查） */
  trigger: '',
  phase: 'idle',
  running: false,
  startedAt: 0,
  finishedAt: 0,
  /** 上游索引信息（失败时也可能有） */
  latestName: '',
  latestSize: 0,
  /** 下载进度：只在 phase=downloading 时有意义 */
  progress: { bytes: 0, total: 0, percent: 0 },
  /** 上一次成功导入的报告摘要（给界面显示「这次补了多少」） */
  result: null,
  lastError: null,
  /** 「这版已经导过了」时的提示（up-to-date 不是失败） */
  skipped: false,
}

export const getDumpJobState = () => structuredClone(state)

const resetForRun = (trigger) => {
  state.trigger = trigger
  state.phase = 'checking'
  state.running = true
  state.startedAt = Date.now()
  state.finishedAt = 0
  state.progress = { bytes: 0, total: 0, percent: 0 }
  state.result = null
  state.lastError = null
  state.skipped = false
}

/**
 * 启动一次更新（**不 await**：调用方立刻返回，界面轮询 /api/dump/status）
 * @param {{ force?: boolean, trigger?: 'manual'|'auto', log?: object }} [options]
 * @returns {{ started: boolean, state: object, done: Promise<object>|null }}
 *   `done` 给 worker 用（它需要知道成败来算失败退避）；界面不用它，只轮询 status。
 */
export function startDumpUpdate({ force = false, trigger = 'manual', log } = {}) {
  if (state.running) return { started: false, state: getDumpJobState(), done: null }
  resetForRun(trigger)
  /* 内部自己 try/catch 到底，绝不产生未处理的 rejection；
     同时把同一个 Promise 交给调用方（want it 的 worker 可以 await，不要它也不会悬空报警） */
  const done = (async () => {
    try {
      const res = await updateDump({
        force,
        log,
        onPhase: (phase) => {
          state.phase = phase
        },
        /* 注意字段名：下载层给的是 `{ downloaded, total }`（那是它的历史命名），
           这里统一成 `bytes` 再往界面送 —— 曾经按 `bytes` 直接取，结果进度永远 0。 */
        onProgress: ({ downloaded, bytes, total } = {}) => {
          const got = Number(bytes ?? downloaded) || 0
          const all = Number(total) || 0
          state.progress = {
            bytes: got,
            total: all,
            percent: all ? Math.min(99, Math.round((got / all) * 100)) : 0,
          }
        },
      })
      state.latestName = res.index?.name || ''
      state.latestSize = Number(res.index?.size) || 0
      state.skipped = res.status === 'up-to-date'
      if (res.status === 'imported') {
        const r = res.imported || {}
        state.result = {
          name: res.index?.name || '',
          matched: r.matched ?? 0,
          patched: r.patched ?? 0,
          relations: r.relations ?? 0,
          index: r.stubs ?? 0,
          seriesReset: r.seriesReset ?? 0,
          ms: r.ms ?? 0,
        }
        state.progress = { ...state.progress, percent: 100 }
      }
      state.phase = 'done'
      return res
    } catch (err) {
      state.phase = 'failed'
      state.lastError = err?.message || String(err)
      log?.warn?.({ err: state.lastError, trigger }, 'dump.job fail')
      throw err
    } finally {
      state.running = false
      state.finishedAt = Date.now()
    }
  })()
  /* 没人 await 时别让 rejection 变成 unhandledRejection（worker 会 await，路线不 await） */
  done.catch(() => {})
  return { started: true, state: getDumpJobState(), done }
}
