/**
 * 首页排期数据 —— 请求状态 + 三态判定
 * ---------------------------------------------------------------------------
 * 职责边界（对应「页面不请求」的约定）：
 *   · 页面（HomePage）继续只拿 props、只上抛事件，不在这里、也不在页面里发请求
 *   · 容器（App.vue）调本 composable，把结果当 props 传下去，并接管页面的事件
 *   · 三态直接由请求状态推导（uiState），页面里那个「预览开关」已经删掉
 *   · 记住「上次选中的季」：刷新后仍停在那一季（loadStoredSeason / saveStoredSeason）
 *
 * 以后要换数据源 / 加缓存 / 加轮询，只改这一个文件。
 */
import { computed, ref } from 'vue'
import { fetchHomeSchedule } from '@/api/home'
import { SEASONS } from '@/utils/season'

/** 记住「上次选中的季」：刷新页面不该跳回最新季（属前端偏好，和主题一样放 localStorage） */
const SEASON_STORAGE_KEY = 'soraikahub:season'

/** 读上次选的季；没存过 / 存坏了 / 隐私模式禁了存储 → null（交给后端按当前季给） */
function loadStoredSeason() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SEASON_STORAGE_KEY) || 'null')
    const year = Number(parsed?.year)
    if (!Number.isInteger(year) || year < 1970 || !SEASONS.includes(parsed?.season)) return null
    return { year, season: parsed.season }
  } catch {
    return null
  }
}

/** 只在「用户显式选季」时写入 —— 否则默认季也会被记下来，新番季来了就永远停在旧季 */
function saveStoredSeason({ year, season }) {
  try {
    window.localStorage.setItem(SEASON_STORAGE_KEY, JSON.stringify({ year, season }))
  } catch {
    /* 存不了不影响本次会话 */
  }
}

export function useSchedule() {
  /**
   * 数据还没回来之前，先用它显示季选标签（避免刷新时先闪一下"当前季"再跳回记忆里的季）
   * 不响应式：只在组合式函数创建时读一次，用户切季后 fetch 返回的 season 会覆盖显示。
   */
  const storedSeason = loadStoredSeason()

  /** 后端返回的整包数据：{ season, years, days, meta } */
  const data = ref(null)
  const loading = ref(false)
  /** @type {import('vue').Ref<import('@/api/http').ApiError | null>} */
  const error = ref(null)

  // 快速切季时，旧的响应可能后到 —— 用序号丢弃过期结果，避免页面闪回上一季
  let requestSeq = 0

  /**
   * 三态：loading / error / empty / ready
   * 判定优先级刻意做成「请求中 > 出错 > 空 > 就绪」，简单可预期：
   * 切季失败时显示错误态 + 重试，而不是继续摆上一季的卡片（那会让人误以为是新数据）。
   */
  const uiState = computed(() => {
    if (loading.value) return 'loading'
    if (error.value) return 'error'
    if (!data.value || !data.value.days?.length) return 'empty'
    return 'ready'
  })

  /**
   * 载入某季排期（不传参数 = 后端按当前季给）
   * @param {{ year?: number|string, season?: string, force?: boolean }} [params]
   */
  async function load(params = {}) {
    // 没显式指定季时，优先用上次选过的（否则每次刷新都跳回最新季）
    const stored = !params.year && !params.season ? loadStoredSeason() : null
    const seq = ++requestSeq
    loading.value = true
    error.value = null
    try {
      const res = await fetchHomeSchedule(stored ? { ...params, ...stored } : params)
      if (seq !== requestSeq) return // 已有更新的请求，丢弃本次结果
      data.value = res
    } catch (err) {
      if (seq !== requestSeq) return
      error.value = err
    } finally {
      if (seq === requestSeq) loading.value = false
    }
  }

  /** 重试/刷新：沿用当前季；force 让后端跳过它自己的缓存 */
  function reload({ force = true } = {}) {
    return load({
      year: data.value?.season?.year,
      season: data.value?.season?.season,
      force,
    })
  }

  /** 切季：记住这次选择，再请求那一季 */
  function selectSeason(year, season) {
    saveStoredSeason({ year, season })
    return load({ year, season })
  }

  return { data, loading, error, uiState, load, reload, selectSeason, storedSeason }
}
