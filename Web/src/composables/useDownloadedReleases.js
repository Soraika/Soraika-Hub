/**
 * 面板「已下载」区数据 —— 一份**扁平清单** + 一个字幕组筛选条
 * ---------------------------------------------------------------------------
 * 为什么不像 Mikan 资源那样「先选组、再看该组的列表」：
 *   · 一部番通常只有 1~2 个组在活动，分组后大多数组只有 1 条，点两下才看得到东西
 *   · 要回答的问题是「我下到第几集了」—— 组名是附注（每行右侧标一下），不是分类维度
 * 所以：默认「全部」，清单按集号倒序铺平；顶部筛选条只是**收窄视图**，不改变数据。
 *
 * 与 useReleases 保持同名接口（subgroups / activeId / releases / state），
 * 面板就不用为两种数据源写两套模板。
 */
import { computed, ref } from 'vue'
import { fetchAnimeDownloads } from '@/api/downloads'

export function useDownloadedReleases() {
  const animeId = ref(null)
  /** @type {import('vue').Ref<{ items: Array<object>, groups: Array<{name:string,count:number,sizeText:string}> } | null>} */
  const data = ref(null)
  const loading = ref(false)
  /** @type {import('vue').Ref<import('@/api/http').ApiError | null>} */
  const error = ref(null)
  /** 当前筛选：`'all'` = 不筛（默认），否则是组名 */
  const activeId = ref('all')

  let seq = 0

  const items = computed(() => data.value?.items ?? [])
  const groups = computed(() => data.value?.groups ?? [])

  /** 筛选条：第一个永远是「全部」，后面按条数排（后端已排好） */
  const subgroups = computed(() => [
    { id: 'all', name: '全部', count: items.value.length },
    ...groups.value.map((g) => ({ id: g.name, name: g.name, count: g.count })),
  ])

  const activeSubgroup = computed(() => subgroups.value.find((sg) => sg.id === activeId.value) || null)

  const releases = computed(() =>
    activeId.value === 'all' ? items.value : items.value.filter((it) => it.subgroup === activeId.value),
  )

  const subgroupState = computed(() => {
    if (loading.value) return 'loading'
    if (error.value) return 'error'
    if (!items.value.length) return 'empty'
    return 'ready'
  })
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
      activeId.value = 'all' // 默认看全量（不按组分）
    } catch (err) {
      if (current !== seq) return
      error.value = err
    } finally {
      if (current === seq) loading.value = false
    }
  }

  /** 切筛选：纯内存（一次请求已经把全部条目拿回来了） */
  function select(id) {
    if (id == null) return
    activeId.value = id
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
    activeId.value = 'all'
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
    /** 当前视图（全部或某组）的体积 */
    sizeText: computed(() => {
      const list = releases.value
      const bytes = list.reduce((n, it) => n + (it.sizeBytes || 0), 0)
      if (!bytes) return ''
      const units = ['B', 'KB', 'MB', 'GB', 'TB']
      let v = bytes
      let i = 0
      while (v >= 1024 && i < units.length - 1) {
        v /= 1024
        i++
      }
      return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
    }),
    open,
    retry,
    reset,
  }
}
