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
import { fillCards } from '@/api/anime'
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
  /**
   * 正在**请求中**的那一季（用户刚点下去、数据还没回来）
   * ---------------------------------------------------------------------------
   * 为什么需要：季选的标签取的是「服务端返回的季」，请求要 0.3~3 秒 ——
   * 这期间标签还停在上一个季，用户会以为"点了没反应 / 打不开"。
   * 点下去就先把标签换成他要的那一季，回来后再以服务端为准。
   */
  const pending = ref(null)
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
    const asking = stored ? { ...params, ...stored } : params
    pending.value = asking.year && asking.season ? { ...asking, label: `${asking.year} ${asking.season}` } : null
    try {
      const res = await fetchHomeSchedule(asking)
      if (seq !== requestSeq) return // 已有更新的请求，丢弃本次结果
      data.value = res
    } catch (err) {
      if (seq !== requestSeq) return
      error.value = err
    } finally {
      if (seq === requestSeq) {
        loading.value = false
        pending.value = null
      }
    }
  }

  /**
   * 渐进填充：把「还没有评分」的卡片分批送去后端补一遍，补到就合并进当前数据
   * ---------------------------------------------------------------------------
   * 为什么需要：首页的评分来自 Bangumi，而评分的入口是「mikan_id → bgm_id → 条目」。
   * 新番季刚扫进来时大量作品还没解析出 bgm_id，卡片就是「暂无评分 / 没评论数」——
   * 以前只能等后台 worker 慢吞吞地过队列（几十条/分钟），用户看到的就是「一屏都没数据」。
   *
   * 这里做三件事：
   *   ① 先把**所有**缺分的 id 收集起来（一屏 85 张就 85 个）
   *   ② 每批 12 个顺序发（后端一次最多 24，内部 3 并发）
   *   ③ 每批回来立刻合并进 `data.days`，页面无需重渲染整体，卡片自己就填上了
   * 合并用 `id` 对齐、只覆盖「补到值」的字段：补不成的保持原样（继续显示「暂无评分」），
   * 不会把已经有的标题/海报弄丢。
   *
   * 只在前端跑（不占后端 worker 队列）：用户看到的页面优先补齐 —— 这就是「优先在线」。
   * @param {{ signal?: {cancelled:boolean} }} [options] 切季时用来中止后续批次
   */
  async function fillMissing({ signal } = {}) {
    const days = data.value?.days
    if (!Array.isArray(days)) return { filled: 0 }
    const ids = []
    for (const day of days) {
      for (const item of day.items || []) {
        if (item?.id && (item.score == null || !item.ratingText)) ids.push(item.id)
      }
    }
    if (!ids.length) return { filled: 0 }

    const BATCH = 12
    let filled = 0
    for (let i = 0; i < ids.length; i += BATCH) {
      if (signal?.cancelled) break
      try {
        const res = await fillCards(ids.slice(i, i + BATCH))
        for (const card of res?.items || []) {
          const target = days.flatMap((d) => d.items || []).find((it) => it.id === card.id)
          if (!target) continue
          target.score = card.score ?? target.score
          target.scoreText = card.scoreText || target.scoreText
          target.ratingText = card.ratingText || target.ratingText
          target.metaText = card.metaText || target.metaText
          target.poster = card.poster || target.poster
          target.bgmId = card.bgmId ?? target.bgmId
          filled++
        }
      } catch {
        /* 这一批失败（上游抖动）→ 跳过，下一批照常；用户看到的就是「这几张还没评分」 */
      }
      /* 批间稍等一下：别把上游打急（也顺带让「慢慢填上」的观感自然些） */
      await new Promise((r) => setTimeout(r, 120))
    }
    return { filled }
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

  return { data, loading, error, uiState, load, reload, selectSeason, storedSeason, pending, fillMissing }
}
