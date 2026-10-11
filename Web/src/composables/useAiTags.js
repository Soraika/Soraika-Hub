/**
 * AI 标签解析 —— 面板「AI 位」的数据
 * ---------------------------------------------------------------------------
 * 流程：拿到某个字幕组的资源文件名 → 交给后端 AI 解析 → 得到可点的筛选标签。
 * 几个刻意的决定：
 *   · 先问一次「AI 配好了吗」（/api/ai/tools 的 enabled）：没配就不发解析请求，
 *     直接进 disabled 态显示「未配置」—— 省一次注定 501 的往返
 *   · 每个字幕组的结果在内存里存一份（按 subgroupId）：来回点不重复花钱
 *   · 切字幕组时清空已选标签：筛选条件是「针对上一批资源」的，留着会筛空
 *   · AI_DISABLED 单独成一态（不是错误）：文案要告诉人去填 key，而不是让他重试
 */
import { computed, ref } from 'vue'
import { classifyReleaseTags, fetchAiTools } from '@/api/ai'

/**
 * 合并新一批标签（「显示更多」时用）
 * ---------------------------------------------------------------------------
 * · 同名标签的 `match` 取**并集**：不同批里写法可能不一样，合起来筛得更全
 * · `all`（整批一致）取**与**：只有每一批里都一致，才算"全部资源一致"
 * · 保持原顺序（V8 的 sort 稳定），只把新出现的"可筛"标签往前提一点
 */
function mergeTags(existing, incoming) {
  const merged = new Map(existing.map((tag) => [tag.name, { ...tag, match: [...(tag.match || [])] }]))
  for (const tag of incoming) {
    const hit = merged.get(tag.name)
    if (!hit) {
      merged.set(tag.name, { ...tag, match: [...(tag.match || [])] })
      continue
    }
    hit.match = [...new Set([...hit.match, ...(tag.match || [])])]
    hit.all = Boolean(hit.all) && Boolean(tag.all)
    if (tag.kind) hit.kind = tag.kind
    if (tag.count) hit.count = tag.count
  }
  return [...merged.values()].sort((a, b) => Number(a.all) - Number(b.all))
}

export function useAiTags() {
  /** idle | loading | ready | error | disabled */
  const state = ref('idle')
  const tags = ref([])
  /** 选中的标签名（筛选条件） */
  const activeNames = ref([])
  /**
   * 资源类型过滤：all（全部）| single（单集）| batch（合集）
   * 与标签维度无关（它筛的是「资源形态」），所以单独放在标签之外。
   */
  const batchFilter = ref('all')
  /**
   * 多标签口径**不由用户切**（照旧版）：同类型的标签之间是 OR、不同类型之间是 AND。
   * 理由：同一维度（如分辨率）用户通常想「任一」，跨维度通常想「同时满足」——
   * 这是固定语义，让用户切换只会增加理解成本。前端用 AND/OR 连接词把它画出来即可。
   */
  const model = ref('')
  /** @type {import('vue').Ref<import('@/api/http').ApiError | null>} */
  const error = ref(null)

  /** 字幕组 id → 标签结果 */
  const cache = new Map()
  /** AI 是否可用（第一次问过之后就不再问） */
  const enabled = ref(null)
  /**
   * 「这份结果还算不算数」的令牌。
   * 非累加请求（首屏/切字幕组）会 ++：它一发出，之前所有请求作废（避免旧组结果串进来）；
   * 累加请求（「显示更多」拉下一批）**不改令牌** —— 它和前面批次是同一份数据的不同片段，
   * 不能被后来者作废（否则用户连点两次「显示更多」会丢中间那批的结果）。
   */
  let token = 0

  /** 选中的标签对象（给资源列表过滤用） */
  const activeTags = computed(() => tags.value.filter((t) => activeNames.value.includes(t.name)))

  async function ensureEnabled() {
    if (enabled.value !== null) return enabled.value
    try {
      const info = await fetchAiTools()
      enabled.value = Boolean(info.enabled)
      model.value = info.model || ''
    } catch {
      // 清单都取不到（后端没起/代理问题）：当成不可用，别再往下打解析请求
      enabled.value = false
    }
    return enabled.value
  }

  /**
   * 解析某个字幕组的资源标签
   * @param {number} subgroupId
   * @param {string[]} titles 这一批资源文件名（**一批最多 120 条**，与列表展示同步）
   * @param {string} [animeTitle] 番剧名（让模型有上下文：分得清字幕组名与片源）
   * @param {{ merge?: boolean }} [options] merge=true 时**累加**到已有标签（「显示更多」拉下一批）
   */
  async function load(subgroupId, titles, animeTitle = '', { merge = false } = {}) {
    if (!merge) activeNames.value = []
    error.value = null

    if (!(await ensureEnabled())) {
      state.value = 'disabled'
      return
    }

    const list = (titles || []).filter(Boolean)
    if (!list.length) return

    // 缓存按「字幕组 + 这一批」存：来回切组、反复点「显示更多」都不重复花钱
    const key = `${subgroupId}|${list[0]}|${list.length}`
    const hit = cache.get(key)
    if (hit) {
      tags.value = merge ? mergeTags(tags.value, hit.tags) : hit.tags
      model.value = hit.model || model.value
      state.value = tags.value.length ? 'ready' : 'idle'
      return
    }

    const myToken = merge ? token : ++token
    state.value = 'loading'
    try {
      const res = await classifyReleaseTags(list, { animeTitle })
      if (myToken !== token) return // 已经切到别的字幕组了
      cache.set(key, res)
      tags.value = merge ? mergeTags(tags.value, res.tags) : res.tags
      model.value = res.model || model.value
      state.value = tags.value.length ? 'ready' : 'idle'
    } catch (err) {
      if (myToken !== token) return
      if (err?.code === 'AI_DISABLED') {
        enabled.value = false
        state.value = 'disabled'
        return
      }
      error.value = err
      state.value = 'error'
    }
  }

  /** 点标签：单选切换（多选就是多次点击） */
  function toggle(name) {
    const next = new Set(activeNames.value)
    next.has(name) ? next.delete(name) : next.add(name)
    activeNames.value = [...next]
  }

  function clear() {
    activeNames.value = []
  }

  /** 失败后重试：只清掉**这一批**的缓存重来（别把前面批次的成果也丢了） */
  async function retry(subgroupId, titles, animeTitle = '', options) {
    const list = (titles || []).filter(Boolean)
    cache.delete(`${subgroupId}|${list[0]}|${list.length}`)
    return load(subgroupId, list, animeTitle, options)
  }

  /** 切换资源类型过滤（单集 / 合集 / 全部） */
  function setBatchFilter(value) {
    batchFilter.value = ['all', 'single', 'batch'].includes(value) ? value : 'all'
  }

  return {
    state,
    tags,
    activeTags,
    activeNames,
    batchFilter,
    setBatchFilter,
    model,
    error,
    enabled,
    load,
    retry,
    toggle,
    clear,
  }
}
