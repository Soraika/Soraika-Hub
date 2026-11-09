/**
 * 作品详情数据 —— 侧边面板的开关 + 三态
 * ---------------------------------------------------------------------------
 * 与 useSchedule 同一套边界：容器（App.vue）调它，页面只拿 props、只上抛事件。
 * 几个刻意的决定：
 *   · 全站只开一个面板：同时只看一部作品，状态一份就够（以后发现页/搜索页/下载页
 *     点海报都走这里，不用各自维护开关）
 *   · 请求带序号：快速点 A → B 时，A 的响应后到不许盖掉 B（与切季同理）
 *   · 同一个 id 再点一次不重发请求：面板本来就开着，重取只会白闪一下
 *   · 关闭时**保留**数据：从首页切到发现页再切回来，面板能立刻摆回原内容
 */
import { computed, ref } from 'vue'
import { fetchAnimeDetail } from '@/api/anime'

export function useAnimeDetail() {
  /** 当前打开的作品主键；null = 面板关闭 */
  const animeId = ref(null)
  /** @type {import('vue').Ref<object | null>} 后端详情 DTO（字段见 api/anime.js） */
  const data = ref(null)
  const loading = ref(false)
  /** @type {import('vue').Ref<import('@/api/http').ApiError | null>} */
  const error = ref(null)

  // 快速连点两张海报时，旧响应可能后到 —— 用序号作废它
  let requestSeq = 0

  /**
   * loading 至少显示这么久（毫秒）
   * ---------------------------------------------------------------------------
   * 本地接口 20~50ms 就回来了 → 不兜一下的话 loading 只渲染一帧，用户看到的是
   * "点了没反应、然后内容直接变了"。180ms 既看不出来慢、又能让刷新动画真的露出来。
   */
  // 260ms：比一帧长得多（骨架动画看得清），又明显短于一次 AI 解析（通常 2s+），
  // 既掩盖了骨架闪跳、也不会让人觉得切换变慢；观感再由面板的 detail-in 淡入补。
  const MIN_LOADING_MS = 260
  const waitRest = async (startedAt) => {
    const rest = MIN_LOADING_MS - (Date.now() - startedAt)
    if (rest > 0) await new Promise((resolve) => setTimeout(resolve, rest))
  }

  /** 面板是否可见（宽度展开动画由组件负责，这里只管「该不该开」） */
  const visible = computed(() => animeId.value !== null)

  /** 三态：loading / error / empty / ready（与首页同一套判定优先级） */
  const uiState = computed(() => {
    if (loading.value) return 'loading'
    if (error.value) return 'error'
    if (!data.value) return 'empty'
    return 'ready'
  })

  async function load(id) {
    const seq = ++requestSeq
    const startedAt = Date.now()
    loading.value = true
    error.value = null
    try {
      const res = await fetchAnimeDetail(id)
      if (seq !== requestSeq) return // 已有更新的请求（换了作品或已关闭），丢弃本次结果
      await waitRest(startedAt) // 别让 loading 只闪一帧（见 MIN_LOADING_MS）
      if (seq !== requestSeq) return
      data.value = res
    } catch (err) {
      if (seq !== requestSeq) return
      await waitRest(startedAt)
      if (seq !== requestSeq) return
      error.value = err
    } finally {
      if (seq === requestSeq) loading.value = false
    }
  }

  /**
   * 打开某部作品；已打开同一部则什么都不做
   * @param {number} id 作品主键
   */
  function open(id) {
    if (id == null) return
    if (id === animeId.value && !error.value) return
    animeId.value = id
    // 换作品时先清旧内容（否则会拿上一部的内容闪一下）；重试同一部则保留
    if (data.value?.id !== id) data.value = null
    return load(id)
  }

  /** 关闭面板：序号 +1 顺手作废在途请求，旧响应回来也不会再把内容写进去 */
  function close() {
    requestSeq++
    animeId.value = null
    loading.value = false
    error.value = null
  }

  /** 面板内「重试」（失败态按钮） */
  function retry() {
    return animeId.value == null ? undefined : load(animeId.value)
  }

  return { animeId, data, loading, error, visible, uiState, open, close, retry }
}
