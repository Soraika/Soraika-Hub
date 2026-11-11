/**
 * 搜索页数据 —— 关键词 → 结果卡片
 * ---------------------------------------------------------------------------
 * 与别的 composable 同一套边界：请求/状态都在这里，页面只拿 props。
 * 三个刻意的决定：
 *   · 防抖 300ms：中文输入法一次输入会触发多次 input，不防抖就是每敲一个字打一次接口
 *   · 请求带序号：先搜「巨人」再搜「进击」时，先发的响应后到不许盖掉后面的结果
 *   · 空关键词不算"空结果"：输入框清空时回到 idle（提示语），不要显示「没有找到」
 */
import { computed, ref } from 'vue'
import { aiSearchAnime, searchAnime } from '@/api/anime'

export function useSearch({ debounceMs = 300 } = {}) {
  const keyword = ref('')
  const items = ref([])
  const loading = ref(false)
  /** @type {import('vue').Ref<import('@/api/http').ApiError | null>} */
  const error = ref(null)
  /** 至少搜过一次（决定 idle 还是 empty） */
  const searched = ref(false)
  /** 上一次真正发出去的关键词（空输入时用它清空结果） */
  const lastQuery = ref('')
  /** AI 模式：开着时先让 AI 把话翻译成关键词/筛选条件 */
  const aiMode = ref(false)
  /** AI 的理解（keyword / 筛选 / 推荐来源 / reason）；普通搜索时为 null */
  const intent = ref(null)
  /** AI 没接上（未配置 / 跑偏）时的说明 —— 界面据此告诉用户「已退回关键词搜索」 */
  const aiNote = ref('')

  let seq = 0
  let timer = 0

  const uiState = computed(() => {
    if (loading.value) return 'loading'
    if (error.value) return 'error'
    if (!searched.value) return 'idle'
    return items.value.length ? 'ready' : 'empty'
  })

  /** 开关 AI 模式：关掉时把「AI 的理解」一并清掉，免得界面留着上一轮的说明 */
  function setAiMode(value) {
    aiMode.value = Boolean(value)
    if (!aiMode.value) {
      intent.value = null
      aiNote.value = ''
    }
  }

  async function run(text = keyword.value) {
    const q = String(text || '').trim()
    clearTimeout(timer)
    if (!q) {
      // 清空输入 = 回到初始态（不是「没有找到」）
      seq++
      items.value = []
      searched.value = false
      error.value = null
      loading.value = false
      lastQuery.value = ''
      intent.value = null
      aiNote.value = ''
      return
    }
    const mine = ++seq
    loading.value = true
    error.value = null
    try {
      if (aiMode.value) {
        try {
          const res = await aiSearchAnime(q)
          if (mine !== seq) return
          items.value = res.items ?? []
          intent.value = res.intent ?? null
          aiNote.value = ''
        } catch (err) {
          if (mine !== seq) return
          // AI 没配 / 跑偏 → 退回普通搜索：用户要的是「搜到东西」，不是看错误
          aiNote.value =
            err?.code === 'AI_DISABLED' ? 'AI 未配置，已按关键词搜索' : 'AI 没理解这次请求，已按关键词搜索'
          intent.value = null
          const res = await searchAnime(q)
          if (mine !== seq) return
          items.value = res.items ?? []
        }
      } else {
        const res = await searchAnime(q)
        if (mine !== seq) return // 已经有更新的搜索了
        items.value = res.items ?? []
        intent.value = null
        aiNote.value = ''
      }
      lastQuery.value = q
      searched.value = true
    } catch (err) {
      if (mine !== seq) return
      error.value = err
      items.value = []
      searched.value = true
    } finally {
      if (mine === seq) loading.value = false
    }
  }

  /** 输入（防抖后再发） */
  function onInput(value) {
    keyword.value = value
    clearTimeout(timer)
    timer = setTimeout(() => run(keyword.value), debounceMs)
  }

  /** 回车 / 点按钮：立刻搜，不等防抖（可带上顶栏传来的词） */
  function submit(text) {
    return run(text ?? keyword.value)
  }

  /** 从别处（首页顶栏 / 别的页跳过来）带词进来：装词并立刻搜 */
  function apply(value) {
    keyword.value = String(value || '').trim()
    return run(keyword.value)
  }

  /** 失败重试：用上一次的关键词 */
  function retry() {
    return run(keyword.value || lastQuery.value)
  }

  return {
    keyword,
    items,
    loading,
    error,
    uiState,
    aiMode,
    intent,
    aiNote,
    setAiMode,
    onInput,
    submit,
    apply,
    retry,
  }
}
