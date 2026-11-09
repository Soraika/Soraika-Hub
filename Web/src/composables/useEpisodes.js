/**
 * 资源集数 —— **交给 AI 逐条解析**
 * ---------------------------------------------------------------------------
 * 为什么不靠前端正则：文件名写法永远补不完（`- 1180 (B-Global 3840x2160 …)`、
 * `S01E12`、`第1180集`、`[04v2]`…），而 AI 对每条都给得出准确结果。
 * 前端规则只在前端做**兜底**（AI 没配 / 失败 / 某条没解析出来时才用）。
 *
 * 与展示同步的**分批**：一次一批（默认 120 条），用户点「显示更多」时再解析下一批，
 * 结果**累加**到已有映射里（`merge`）—— 不重来、不重复花钱。
 * 结果里的 `episodes` 是 `{ 文件名: 集号数字 或 "1-12"（合集）或 null }`。
 */
import { ref } from 'vue'
import { classifyEpisodes } from '@/api/ai'

export function useEpisodes() {
  /** idle | loading | ready | error | disabled */
  const state = ref('idle')
  /** title → 集号 / 范围 */
  const episodes = ref({})
  /** @type {import('vue').Ref<import('@/api/http').ApiError | null>} */
  const error = ref(null)

  const cache = new Map()
  /**
   * 「这份结果还算不算数」的令牌：非累加（首批/换作品）会 ++ 作废之前所有请求；
   * 累加（「显示更多」下一批）不改令牌，免得被后来者作废而丢结果。
   */
  let token = 0

  /**
   * @param {string} animeTitle 作品标题（帮模型认清这批资源属于谁）
   * @param {string[]} titles 这一批资源文件名（一批最多 120 条）
   * @param {{ merge?: boolean, season?: string|number }} [options]
   *   merge=true 时累加到已有结果（「显示更多」拉下一批）；season 只做消歧（进 prompt，不进缓存 key）
   */
  async function load(animeTitle, titles, { merge = false, season: seasonHint = '' } = {}) {
    const list = (titles || []).filter(Boolean)
    if (!animeTitle || !list.length) return

    const key = `${animeTitle}|${list[0]}|${list.length}`
    const hit = cache.get(key)
    if (hit) {
      episodes.value = merge ? { ...hit.episodes, ...episodes.value } : hit.episodes || {}
      state.value = 'ready'
      return
    }

    const myToken = merge ? token : ++token
    state.value = 'loading'
    error.value = null
    try {
      const res = await classifyEpisodes(animeTitle, list, { season: seasonHint })
      if (myToken !== token) return // 已经切到别的字幕组/作品了
      cache.set(key, res)
      episodes.value = merge ? { ...res.episodes, ...episodes.value } : res.episodes || {}
      state.value = 'ready'
    } catch (err) {
      if (myToken !== token) return
      if (err?.code === 'AI_DISABLED') {
        // 没配 AI 不是错误：规则兜底照样能用，别弹错误态
        state.value = 'disabled'
        return
      }
      error.value = err
      state.value = 'error'
    }
  }

  return { state, episodes, error, load }
}
