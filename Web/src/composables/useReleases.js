/**
 * 资源区数据 —— 字幕组（第一级）→ 资源列表（第二级）
 * ---------------------------------------------------------------------------
 * 为什么这份状态放在 composable、而不是像排期那样挂在 App.vue：
 *   · 它只属于「面板当前这一部作品」—— 面板一关就没意义，放全局只会把容器撑大
 *   · 页面/容器约定（「页面只摆、容器取数」）是给**页面**定的；面板是高内聚交互单元，
 *     取数逻辑收在这里，面板组件本身仍然只负责摆
 * 几个刻意的决定：
 *   · 打开作品后**默认选中第一个字幕组**：进面板就该看得见资源（旧版也是这个行为）
 *   · 每个字幕组的结果在内存里存一份：来回点不重复打上游（后端另有 5 分钟缓存，
 *     这里省的是那一次网络往返）
 *   · 切换字幕组时旧列表先留着，新结果回来再换（否则每次点都闪一下空白）
 *   · 出错才清空列表：留着上一个字幕组的资源会让人看串
 */
import { computed, ref } from 'vue'
import { fetchAnimeSubgroups, fetchSubgroupReleases } from '@/api/anime'

export function useReleases() {
  /** 当前作品主键（切换作品时用它作废在途响应） */
  const animeId = ref(null)

  const subgroups = ref([])
  const subgroupsLoading = ref(false)
  /** @type {import('vue').Ref<import('@/api/http').ApiError | null>} */
  const subgroupsError = ref(null)

  const activeId = ref(null)
  const releases = ref([])
  const releasesLoading = ref(false)
  /** @type {import('vue').Ref<import('@/api/http').ApiError | null>} */
  const releasesError = ref(null)

  /** 字幕组 id → 资源数组 */
  const cache = new Map()
  let subgroupSeq = 0
  let releaseSeq = 0

  const activeSubgroup = computed(() => subgroups.value.find((sg) => sg.id === activeId.value) || null)

  const subgroupState = computed(() => {
    if (subgroupsLoading.value) return 'loading'
    if (subgroupsError.value) return 'error'
    if (!subgroups.value.length) return 'empty'
    return 'ready'
  })

  const releaseState = computed(() => {
    if (releasesLoading.value) return 'loading'
    if (releasesError.value) return 'error'
    if (!releases.value.length) return 'empty'
    return 'ready'
  })

  /** 打开某部作品：字幕组重取，选中回到第一个 */
  async function open(id) {
    reset()
    animeId.value = id

    const seq = ++subgroupSeq
    subgroupsLoading.value = true
    try {
      const res = await fetchAnimeSubgroups(id)
      if (seq !== subgroupSeq) return
      subgroups.value = res.items
      if (res.items.length) await select(res.items[0].id)
    } catch (err) {
      if (seq !== subgroupSeq) return
      subgroupsError.value = err
    } finally {
      if (seq === subgroupSeq) subgroupsLoading.value = false
    }
  }

  /**
   * 切到某个字幕组（命中内存缓存就直接换）
   * @param {number} subgroupId subgroup 主键
   */
  async function select(subgroupId) {
    const id = animeId.value
    if (id == null || subgroupId == null) return

    activeId.value = subgroupId
    releasesError.value = null

    const hit = cache.get(subgroupId)
    if (hit) {
      releases.value = hit
      return
    }

    const seq = ++releaseSeq
    releasesLoading.value = true
    try {
      const res = await fetchSubgroupReleases(id, subgroupId)
      if (seq !== releaseSeq || animeId.value !== id) return // 换了作品/更快的一次点击后到了
      cache.set(subgroupId, res.items)
      releases.value = res.items
    } catch (err) {
      if (seq !== releaseSeq || animeId.value !== id) return
      releasesError.value = err
      releases.value = [] // 出错别留上一个字幕组的资源（会看串）
    } finally {
      if (seq === releaseSeq) releasesLoading.value = false
    }
  }

  /** 资源区里的「重试」：字幕组没取到就重取字幕组，否则重取当前字幕组的资源 */
  function retry() {
    if (animeId.value == null) return undefined
    if (subgroupsError.value || !subgroups.value.length) return open(animeId.value)
    return activeId.value == null ? undefined : select(activeId.value)
  }

  /** 关面板 / 换作品前清干净（序号 +1 顺手作废在途请求） */
  function reset() {
    subgroupSeq++
    releaseSeq++
    animeId.value = null
    subgroups.value = []
    subgroupsLoading.value = false
    subgroupsError.value = null
    activeId.value = null
    releases.value = []
    releasesLoading.value = false
    releasesError.value = null
    cache.clear()
  }

  return {
    subgroups,
    subgroupsLoading,
    subgroupsError,
    subgroupState,
    activeId,
    activeSubgroup,
    select,
    releases,
    releasesLoading,
    releasesError,
    releaseState,
    open,
    retry,
    reset,
  }
}
