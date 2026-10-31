/**
 * 面板「已下载」区数据 —— 与 useReleases 同一套接口（字幕组 → 条目），但来源是 qB
 * ---------------------------------------------------------------------------
 * 为什么保持同样的接口名：面板里这两种视图（Mikan 资源 / 已下载）共用一套模板结构
 * （SubgroupBar + 下面一层列表），只是数据源不同。接口一致，面板就能「换一个 composable」
 * 而不是再写一份面板。
 *
 * 与 useReleases 的差别：
 *   · 一次请求就把「组 + 每组的条目」全拿到（qB 一次种子列表就够了），
 *     所以切组是**纯内存操作**，没有第二个 loading 态
 *   · 只读：已下载的东西不能在这里重取/重排，所以 `retry` 只是重拉这一部
 */
import { computed, ref } from 'vue'
import { fetchAnimeDownloads } from '@/api/downloads'

export function useDownloadedReleases() {
  const animeId = ref(null)
  /** @type {import('vue').Ref<{ subgroups: Array<object>, total: number, sizeText: string } | null>} */
  const data = ref(null)
  const loading = ref(false)
  /** @type {import('vue').Ref<import('@/api/http').ApiError | null>} */
  const error = ref(null)
  const activeId = ref(null)

  let seq = 0

  const subgroups = computed(() => data.value?.subgroups ?? [])
  const activeSubgroup = computed(() => subgroups.value.find((sg) => sg.id === activeId.value) || null)
  const releases = computed(() => activeSubgroup.value?.items ?? [])

  const subgroupState = computed(() => {
    if (loading.value) return 'loading'
    if (error.value) return 'error'
    if (!subgroups.value.length) return 'empty'
    return 'ready'
  })
  /** 数据一次到手 → 组里没东西就是「这一组没有已下载的」（正常空态） */
  const releaseState = computed(() => {
    if (loading.value) return 'loading'
    if (error.value) return 'error'
    if (!releases.value.length) return 'empty'
    return 'ready'
  })

  async function open(id) {
    if (id == null) return
    reset()
    animeId.value = id
    const current = ++seq
    loading.value = true
    try {
      const res = await fetchAnimeDownloads(id)
      if (current !== seq) return
      data.value = res
      activeId.value = res.subgroups[0]?.id ?? null
    } catch (err) {
      if (current !== seq) return
      error.value = err
    } finally {
      if (current === seq) loading.value = false
    }
  }

  /** 切组：纯内存（qs 一次就把所有组都给了） */
  function select(subgroupId) {
    if (subgroupId == null) return
    activeId.value = subgroupId
  }

  function retry() {
    return animeId.value == null ? undefined : open(animeId.value)
  }

  function reset() {
    seq++
    animeId.value = null
    data.value = null
    loading.value = false
    error.value = null
    activeId.value = null
  }

  return {
    subgroups,
    subgroupState,
    activeId,
    activeSubgroup,
    select,
    releases,
    releaseState,
    error,
    total: computed(() => data.value?.total ?? 0),
    /** 当前**这一组**的体积（面板标题右边那个）；空组给空串 */
    sizeText: computed(() => activeSubgroup.value?.sizeText ?? ''),
    open,
    retry,
    reset,
  }
}
