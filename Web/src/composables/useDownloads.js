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

  const configured = computed(() => Boolean(data.value?.configured))
  const items = computed(() => data.value?.items ?? [])
  const unmatched = computed(() => data.value?.unmatched ?? [])
  const counts = computed(() => data.value?.counts ?? {})
  const versions = computed(() => data.value?.versions ?? null)
  const transfer = computed(() => data.value?.transfer ?? null)

  return { data, loading, refreshing, error, uiState, configured, items, unmatched, counts, versions, transfer, load }
}
