/**
 * 下载页数据 —— 卡片墙 + 刷新 + 三态
 * ---------------------------------------------------------------------------
 * 与 useSchedule 同一套边界：容器（App.vue）调它，页面只拿 props、只上抛事件。
 * 两个刻意的决定：
 *   · `fresh` 只由「刷新」按钮传 true —— 进页面走后端 4 秒缓存，来回切页不反复打 qB
 *   · 刷新时**保留旧数据**（`refreshing` 另开一个状态）：卡片墙整个转圈再回来，看着像页面挂了
 */
import { computed, ref } from 'vue'
import { fetchDownloads } from '@/api/downloads'

export function useDownloads() {
  /** @type {import('vue').Ref<object | null>} 见 api/downloads.js 的形状 */
  const data = ref(null)
  const loading = ref(false)
  /** 刷新中（已有数据，只是后台再取一次） */
  const refreshing = ref(false)
  /** @type {import('vue').Ref<import('@/api/http').ApiError | null>} */
  const error = ref(null)

  let seq = 0

  async function load({ fresh = false } = {}) {
    const current = ++seq
    if (data.value && fresh) refreshing.value = true
    else loading.value = true
    error.value = null
    try {
      const res = await fetchDownloads({ fresh })
      if (current !== seq) return
      data.value = res
    } catch (err) {
      if (current !== seq) return
      error.value = err
      if (!fresh) data.value = null
    } finally {
      if (current === seq) {
        loading.value = false
        refreshing.value = false
        // 每次取完都重新评估「还要不要继续轮询」（下完了就停表）
        syncPolling()
      }
    }
  }

  /** loading | error | empty | ready（卡片墙为空也算 empty：界面给「还没有下载」的引导） */
  const uiState = computed(() => {
    if (loading.value) return 'loading'
    if (error.value) return 'error'
    const d = data.value
    // 还没取过：这是「正在加载」而不是「没配置」——否则进页面会先闪一下
    // 「还没有连上 qBittorrent」，紧接着又变成卡片墙
    if (!d) return 'loading'
    if (!d.configured) return 'ready' // 未配置：页面给引导，不算空态
    if (!d.items.length && !d.unmatched.length) return 'empty'
    return 'ready'
  })

  /**
   * 自动刷新（**只在有任务在跑时**）
   * -------------------------------------------------------------------------
   * qB 的进度不会自己推到页面上，不刷新的话「下载中 94%」会一直停在 94%——
   * 那看着就像卡死了。但也不能无条件轮询：全都下完还每 5 秒打一次 qB，
   * 纯属浪费（而且用户只是回来看看，页面安安静静就好）。
   * 规则：`counts.downloading > 0` → 每 5 秒拉一次（走后端 4 秒缓存，不会真的打满 qB）；
   *      没有下载中的任务 → 立刻停表。
   */
  const POLL_MS = 5000
  let timer = null
  /** 页面在的时候才允许轮询（切走就停，别让后台一直打 qB） */
  const autoRefresh = ref(false)
  /** 给界面用：正在自动刷新（timer 是普通变量，不能用 computed 包它 —— 那样不会更新） */
  const polling = ref(false)

  function syncPolling() {
    const active = autoRefresh.value && Number(counts.value.downloading) > 0
    if (active && !timer) {
      timer = setInterval(() => {
        // 上一轮还没回来就别叠加（qB 卡住时最容易堆请求）
        if (!loading.value && !refreshing.value) load({ fresh: true })
      }, POLL_MS)
    } else if (!active && timer) {
      clearInterval(timer)
      timer = null
    }
    polling.value = Boolean(timer)
  }

  function startAutoRefresh() {
    autoRefresh.value = true
    syncPolling()
  }
  function stopAutoRefresh() {
    autoRefresh.value = false
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  const configured = computed(() => Boolean(data.value?.configured))
  const items = computed(() => data.value?.items ?? [])
  const unmatched = computed(() => data.value?.unmatched ?? [])
  const counts = computed(() => data.value?.counts ?? {})
  const versions = computed(() => data.value?.versions ?? null)
  const transfer = computed(() => data.value?.transfer ?? null)

  return {
    data,
    loading,
    refreshing,
    error,
    uiState,
    configured,
    items,
    unmatched,
    counts,
    versions,
    transfer,
    polling,
    load,
    startAutoRefresh,
    stopAutoRefresh,
  }
}
