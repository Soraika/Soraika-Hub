/**
 * 提示词只读查看器（设置页用）
 * ---------------------------------------------------------------------------
 * 这里只做三件事：看见当前四段提示词长什么样、知道哪段被改过、能一键恢复默认。
 * 不提供编辑框，原因很实际：改提示词要懂输出契约（JSON 里必须有哪些字段），
 * 在网页 textarea 里随手改坏一段，表现是「标签突然全没了」，很难联想到提示词。
 * 真要改：编辑 Server/data/prompts.json（按 mtime 热加载，不用重启），或 PUT /api/ai/prompts。
 *
 * 恢复默认会真的写盘（删掉对应覆盖），所以每段一次确认。
 */
import { computed, ref } from 'vue'
import { fetchAiPrompts, resetAiPrompts, saveAiPrompts } from '@/api/ai'

export function usePrompts() {
  /** @type {import('vue').Ref<null | { source:string, keys:string[], prompts:object, defaults:object }>} */
  const data = ref(null)
  const loading = ref(false)
  const saving = ref(false)
  /** @type {import('vue').Ref<import('@/api/http').ApiError | null>} */
  const error = ref(null)
  const message = ref('')
  /** 上一次操作的段（按钮显示「已恢复」用） */
  const touched = ref('')

  const keys = computed(() => data.value?.keys ?? [])
  const source = computed(() => data.value?.source ?? '')
  const textOf = (key) => String(data.value?.prompts?.[key]?.system ?? '')
  const defaultOf = (key) => String(data.value?.defaults?.[key] ?? '')
  const hashOf = (key) => String(data.value?.prompts?.[key]?.hash ?? '')
  /** 这一段是不是用户覆盖版（和出厂默认不同） */
  const isCustomized = (key) => Boolean(textOf(key)) && textOf(key) !== defaultOf(key)
  const customizedKeys = computed(() => keys.value.filter((key) => isCustomized(key)))

  async function load() {
    loading.value = true
    error.value = null
    try {
      data.value = await fetchAiPrompts()
    } catch (err) {
      error.value = err
      data.value = null
    } finally {
      loading.value = false
    }
  }

  /** 把某一段恢复成出厂默认（只发那一段的默认正文，后端会把它从覆盖文件里删掉） */
  async function restoreOne(key) {
    if (saving.value) return
    saving.value = true
    message.value = ''
    try {
      await saveAiPrompts({ [key]: { system: defaultOf(key) } })
      await load()
      touched.value = key
      message.value = '已恢复这一段为出厂默认'
    } catch (err) {
      message.value = `恢复失败：${err.message}`
    } finally {
      saving.value = false
    }
  }

  /** 四段全部恢复默认（删掉覆盖文件） */
  async function restoreAll() {
    if (saving.value) return
    saving.value = true
    message.value = ''
    try {
      await resetAiPrompts()
      await load()
      touched.value = '*'
      message.value = '四段都已恢复为出厂默认'
    } catch (err) {
      message.value = `恢复失败：${err.message}`
    } finally {
      saving.value = false
    }
  }

  return {
    data,
    loading,
    saving,
    error,
    message,
    touched,
    keys,
    source,
    textOf,
    defaultOf,
    hashOf,
    isCustomized,
    customizedKeys,
    load,
    restoreOne,
    restoreAll,
  }
}
