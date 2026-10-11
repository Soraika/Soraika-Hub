/**
 * 进程内 TTL 缓存（带「单飞」）—— 不引第三方库
 * ---------------------------------------------------------------------------
 * 两个用途：
 *   1. TTL 缓存：同一份上游数据（如 Bangumi 季度检索结果）短时间内不重复抓
 *   2. 单飞（single-flight）：同一 key 并发请求时只有第一个真的打上游，其余等它 ——
 *      对应架构图里「实时速度」那条注释的思路（有值就返回，没值但在请求中就等）
 * 进程重启即失效；需要持久化的缓存走 db/ 独立表（架构图里已规划）。
 */

/**
 * @param {{ ttlMs?: number | (() => number), max?: number }} [options]
 * ---------------------------------------------------------------------------
 * `ttlMs` 允许传**函数**：设置页把「缓存时长」改掉后必须**立即生效**，
 * 而缓存实例是模块加载时创建的长生命周期对象 —— 传死值就只能重启进程才生效
 * （以前就是这个问题：界面上改完、提示"已保存"，实际一直用旧值）。
 * 传函数时每次**写入**都重新取一次（写入时决定过期时间，读时只比较）。
 */
export function createMemCache({ ttlMs = 5 * 60 * 1000, max = 200 } = {}) {
  /** @type {Map<string, { value: any, expireAt: number }>} */
  const store = new Map()
  /** @type {Map<string, Promise<any>>} */
  const inflight = new Map()

  /** 当下应使用的 ttl（支持固定值 / 取值函数） */
  const resolveTtl = () => {
    const value = typeof ttlMs === 'function' ? ttlMs() : ttlMs
    return Number.isFinite(value) && value >= 0 ? value : 0
  }

  function get(key) {
    const hit = store.get(key)
    if (!hit) return undefined
    if (hit.expireAt <= Date.now()) {
      store.delete(key)
      return undefined
    }
    return hit.value
  }

  function set(key, value, ttl = resolveTtl()) {
    if (store.size >= max && !store.has(key)) {
      // 简单淘汰：删掉最早写入的一条（够用，不做 LRU）
      store.delete(store.keys().next().value)
    }
    store.set(key, { value, expireAt: Date.now() + ttl })
    return value
  }

  /**
   * 读缓存；没有就跑 fn 并写入。同一个 key 并发调用只会执行一次 fn。
   * @param {string} key
   * @param {() => Promise<any>} fn
   * @param {number} [ttl]
   */
  async function wrap(key, fn, ttl) {
    const cached = get(key)
    if (cached !== undefined) return cached

    const running = inflight.get(key)
    if (running) return running

    const task = (async () => {
      try {
        const value = await fn()
        set(key, value, ttl)
        return value
      } finally {
        inflight.delete(key)
      }
    })()

    inflight.set(key, task)
    return task
  }

  return {
    get,
    set,
    wrap,
    /** 主动失效（换了数据源 / 手动刷新时用） */
    delete: (key) => store.delete(key),
    clear: () => store.clear(),
    size: () => store.size,
  }
}

/** 全站共享：上游抓取的短期缓存 */
export const upstreamCache = createMemCache({ ttlMs: 10 * 60 * 1000, max: 100 })
