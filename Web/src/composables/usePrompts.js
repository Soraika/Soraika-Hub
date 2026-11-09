/**
 * 提示词编辑 —— 两段：系统段（我们的要求）+ 用户补充段
 * ---------------------------------------------------------------------------
 * 分工（也是后端保存时的校验依据）：
 *   system  输出契约（JSON 结构、字段名、禁止事项）。改坏它模型就回不出可用结构，
 *           所以保存时后端会检查关键字段名，缺了就 400；界面上照原样给提示。
 *   custom  使用者自己的补充（偏好、措辞、额外约束）。写什么都不影响结构。
 * 实际发给模型的是两段拼起来（服务端 composePrompt），前端不用管顺序。
 *
 * 三个刻意的决定：
 *   · 草稿与已保存值分开：编辑期间不动服务端，点保存才算数
 *   · 只提交改过的段：没改的段不入库，以后升级出厂默认也能生效
 *   · 保存后重新拉一遍：界面显示的永远是服务端实际生效的内容
 */
import { computed, ref } from 'vue'
import { fetchAiPrompts, resetAiPrompts, saveAiPrompts } from '@/api/ai'

export function usePrompts() {
  /** @type {import('vue').Ref<null | { source:string, keys:string[], defaults:object, prompts:object }>} */
  const data = ref(null)
  /** 草稿：段名 → { system, custom } */
  const draft = ref({})
  const loading = ref(false)
  const saving = ref(false)
  /** @type {import('vue').Ref<import('@/api/http').ApiError | null>} */
  const error = ref(null)
  const message = ref('')

  const keys = computed(() => data.value?.keys ?? [])
  const source = computed(() => data.value?.source ?? '')
  const textOf = (key, part = 'system') => String(data.value?.prompts?.[key]?.[part] ?? '')
  const defaultOf = (key) => String(data.value?.defaults?.[key] ?? '')
  const hashOf = (key) => String(data.value?.prompts?.[key]?.hash ?? '')
  const draftOf = (key, part = 'system') => String(draft.value?.[key]?.[part] ?? '')

  /** 这一段改过没有（系统段或自定义段任一） */
  const isDirty = (key) =>
    Boolean(data.value) &&
    (draftOf(key, 'system') !== textOf(key, 'system') || draftOf(key, 'custom') !== textOf(key, 'custom'))

  /** 这一段是不是「用户改动版」（自定义段有内容，或系统段和出厂默认不同） */
  const isOverridden = (key) => textOf(key, 'custom').trim().length > 0 || textOf(key, 'system') !== defaultOf(key)

  const dirtyKeys = computed(() => keys.value.filter((key) => isDirty(key)))
  const overriddenKeys = computed(() => keys.value.filter((key) => isOverridden(key)))

  async function load() {
    loading.value = true
    error.value = null
    try {
      const res = await fetchAiPrompts()
      data.value = res
      draft.value = Object.fromEntries(
        (res.keys || []).map((key) => [
          key,
          { system: String(res.prompts?.[key]?.system ?? ''), custom: String(res.prompts?.[key]?.custom ?? '') },
        ]),
      )
    } catch (err) {
      error.value = err
      data.value = null
    } finally {
      loading.value = false
    }
  }

  /** 某一段恢复出厂默认：系统段回默认正文、自定义段清空（只改草稿，点保存才写） */
  function restoreDraft(key) {
    draft.value = { ...draft.value, [key]: { system: defaultOf(key), custom: '' } }
  }

  function restoreAllDrafts() {
    draft.value = Object.fromEntries(keys.value.map((key) => [key, { system: defaultOf(key), custom: '' }]))
  }

  /** 放弃编辑（回到已保存内容） */
  function revert() {
    draft.value = Object.fromEntries(
      keys.value.map((key) => [key, { system: textOf(key, 'system'), custom: textOf(key, 'custom') }]),
    )
  }

  /**
   * 保存：只发改过的段（system + custom 一起发，后端会校验系统段的结构说明）
   * @returns {Promise<boolean>}
   */
  async function save() {
    if (saving.value || !data.value) return false
    const changed = dirtyKeys.value
    if (!changed.length) {
      message.value = '没有改动'
      return false
    }
    const payload = {}
    for (const key of changed) {
      const system = draftOf(key, 'system').trim()
      const custom = draftOf(key, 'custom').trim()
      if (!system) {
        message.value = '系统提示词不能为空'
        return false
      }
      payload[key] = { system, custom }
    }

    saving.value = true
    error.value = null
    message.value = ''
    try {
      await saveAiPrompts(payload)
      await load()
      message.value = `已保存 ${changed.length} 段`
      return true
    } catch (err) {
      error.value = err
      message.value = `保存失败：${err.message}`
      return false
    } finally {
      saving.value = false
    }
  }

  /** 立即把某一段写回出厂默认（直接写盘，不走草稿） */
  async function restoreOne(key) {
    if (saving.value) return
    saving.value = true
    message.value = ''
    try {
      await saveAiPrompts({ [key]: { system: defaultOf(key), custom: '' } })
      await load()
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
      message.value = '四段都已恢复为出厂默认'
    } catch (err) {
      message.value = `恢复失败：${err.message}`
    } finally {
      saving.value = false
    }
  }

  return {
    data,
    draft,
    loading,
    saving,
    error,
    message,
    keys,
    source,
    textOf,
    defaultOf,
    hashOf,
    draftOf,
    isDirty,
    isOverridden,
    dirtyKeys,
    overriddenKeys,
    load,
    save,
    revert,
    restoreDraft,
    restoreAllDrafts,
    restoreOne,
    restoreAll,
  }
}
