/**
 * 提示词编辑 —— 界面只暴露「用户补充」这一段
 * ---------------------------------------------------------------------------
 * 两段的分工（跟后端一致）：
 *   system  输出契约（JSON 结构、字段名、禁止事项）。不在界面展示：
 *           它决定模型能不能回出可用结构，普通用户不该在这里动它。
 *           会改文件的人直接编辑 Server/data/prompts.json 或出厂文件。
 *   custom  使用者自己的补充（偏好、措辞、额外约束）。界面只编辑这段。
 * 因此保存时只提交 custom：system 一律不碰，避免界面把别人手改的系统段覆盖回去。
 *
 * 三个刻意的决定：
 *   · 草稿与已保存值分开：编辑期间不动服务端，点保存才算数
 *   · 只提交改过的段，没改的不入库
 *   · 保存后重新拉一遍：界面显示的永远是服务端实际生效的内容
 */
import { computed, ref } from 'vue'
import { fetchAiPrompts, resetAiPrompts, saveAiPrompts } from '@/api/ai'

export function usePrompts() {
  /** @type {import('vue').Ref<null | { source:string, keys:string[], defaults:object, prompts:object }>} */
  const data = ref(null)
  /** 草稿：段名 → 补充段正文（系统段不参与编辑，也不放进草稿） */
  const draft = ref({})
  const loading = ref(false)
  const saving = ref(false)
  /** @type {import('vue').Ref<import('@/api/http').ApiError | null>} */
  const error = ref(null)
  const message = ref('')

  const keys = computed(() => data.value?.keys ?? [])
  const source = computed(() => data.value?.source ?? '')
  const textOf = (key, part = 'custom') => String(data.value?.prompts?.[key]?.[part] ?? '')
  const defaultOf = (key) => String(data.value?.defaults?.[key] ?? '')
  const hashOf = (key) => String(data.value?.prompts?.[key]?.hash ?? '')
  /** 系统段字数：界面只显示一句「系统段 N 字（由程序维护）」，不给编辑 */
  const systemLengthOf = (key) => String(data.value?.prompts?.[key]?.system ?? '').length
  const draftOf = (key) => String(draft.value?.[key] ?? '')

  /** 这一段改过没有（只比补充段：界面不编辑系统段） */
  const isDirty = (key) => Boolean(data.value) && draftOf(key) !== textOf(key)

  /** 这一段是不是「有用户改动」（补充段有内容，或系统段被换过） */
  const isOverridden = (key) => textOf(key).trim().length > 0 || textOf(key, 'system') !== defaultOf(key)

  const dirtyKeys = computed(() => keys.value.filter((key) => isDirty(key)))
  const overriddenKeys = computed(() => keys.value.filter((key) => isOverridden(key)))

  async function load() {
    loading.value = true
    error.value = null
    try {
      const res = await fetchAiPrompts()
      data.value = res
      draft.value = Object.fromEntries((res.keys || []).map((key) => [key, String(res.prompts?.[key]?.custom ?? '')]))
    } catch (err) {
      error.value = err
      data.value = null
    } finally {
      loading.value = false
    }
  }

  /** 放弃编辑（回到已保存内容） */
  function revert() {
    draft.value = Object.fromEntries(keys.value.map((key) => [key, textOf(key)]))
  }

  /**
   * 保存：只提交补充段（system 一律不碰）
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
    for (const key of changed) payload[key] = { custom: draftOf(key).trim() }

    saving.value = true
    error.value = null
    message.value = ''
    try {
      await saveAiPrompts(payload)
      await load()
      message.value = `已保存 ${changed.length} 段补充`
      return true
    } catch (err) {
      error.value = err
      message.value = `保存失败：${err.message}`
      return false
    } finally {
      saving.value = false
    }
  }

  /**
   * 把某一段整段恢复出厂默认（系统段回默认 + 补充段清空）
   * 这是显式动作，所以连系统段一起还原 —— 系统段平时不在界面出现。
   */
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

  /** 各段全部恢复默认（删掉覆盖文件） */
  async function restoreAll() {
    if (saving.value) return
    saving.value = true
    message.value = ''
    try {
      await resetAiPrompts()
      await load()
      message.value = '全部段落都已恢复为出厂默认'
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
    systemLengthOf,
    draftOf,
    isDirty,
    isOverridden,
    dirtyKeys,
    overriddenKeys,
    load,
    save,
    revert,
    restoreOne,
    restoreAll,
  }
}
