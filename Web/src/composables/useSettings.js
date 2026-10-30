/**
 * 设置页数据 —— 拉清单、攒草稿、保存 / 重置 / 导出 / 导入
 * ---------------------------------------------------------------------------
 * 一个刻意的设计：**草稿（draft）只装「用户改过的项」**，没改的项不在里面。
 *   · 保存时只 PUT 这些项 → 后端只覆盖这些，语义与「改过才存」一致
 *   · 传输到 `null` 表示「还原该项为默认」（不是「设为空」），与后端约定一致
 *   · 保存成功、导入成功、重置后都重新拉一遍清单：界面显示的永远是**后端实际生效值**
 *     （不做「前端猜后端」那套，免得两边状态慢慢对不上）
 */
import { computed, ref, watch } from 'vue'
import { fetchAiModels, fetchAiProviders } from '@/api/ai'
import { formatDuration } from '@/utils/duration'
import {
  exportUrl,
  fetchSettings,
  importSettings,
  resetSettings,
  saveSettings,
  testSetting,
} from '@/api/settings'

/**
 * 「基础 / 高级」模式的选择记在本地（纯界面偏好，不写进配置库）
 * 基础 = **必要配置**（不填就用不了 / 必须按环境改的那几项），
 * 高级 = 全部（含各种超时、TTL、并发、退避这些调参项）。
 */
const ADVANCED_KEY = 'soraikahub:settings-advanced'

function readStoredAdvanced() {
  try {
    return window.localStorage.getItem(ADVANCED_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * 两个值在界面上是否等价
 * 目的：用户把值改回原样时，这次改动应当**自动取消**（而不是一直挂着「撤销」，
 * 开关这类点两下就回到原位的交互尤其明显）。数字比数值、布尔比真假、其余比字符串。
 */
function sameValue(next, current) {
  const isEmpty = (v) => v === null || v === undefined || v === ''
  if (isEmpty(next)) return isEmpty(current)
  if (typeof current === 'boolean' || typeof next === 'boolean') return Boolean(next) === Boolean(current)
  if (typeof current === 'number' && /^-?\d+(\.\d+)?$/.test(String(next))) return Number(next) === current
  return String(next) === String(current)
}

export function useSettings() {
  /** @type {import('vue').Ref<object|null>} 后端整包 */
  const data = ref(null)
  /** 用户改过的项：`{ path: value }` */
  const draft = ref({})
  /**
   * 初值就是 true：**「还没拉过」本来就是「正在加载」**。
   * 若初值为 false，首帧会落进「有数据」分支去读 data.xxx —— 而 data 还是 null，
   * 渲染函数直接抛错、整页白屏（onMounted 在首帧之后才跑，救不了）。
   */
  const loading = ref(true)
  const saving = ref(false)
  /** @type {import('vue').Ref<import('@/api/http').ApiError | null>} */
  const error = ref(null)
  /** 操作结果提示（成功/失败都写这里给界面显示） */
  const message = ref('')
  /** 正在保存哪个卡片（卡片按钮显示「保存中…」用） */
  const savingKey = ref('')
  /** 刚保存成功的卡片（按钮变绿显示「保存成功」两秒） */
  const savedKey = ref('')
  /** 点了保存但**没有任何改动**（回一句「无变化」，两秒后复原）——比一个点不动的灰按钮友好 */
  const unchangedKey = ref('')
  let savedTimer = null
  let unchangedTimer = null

  function markUnchanged(key = '') {
    unchangedKey.value = key || '__all__'
    // 不只把按钮染个色：页面上的消息行也要给一句完整的话（不然"无变化"三个字没人看得懂）
    message.value = '无变化 · 已是最新'
    clearTimeout(unchangedTimer)
    unchangedTimer = setTimeout(() => {
      unchangedKey.value = ''
    }, 2000)
  }

  /**
   * 「测试连接」的状态：`path → idle | testing | success | error`
   * 放这里而不是页面：状态与请求是一件事，而且卡片按钮要按 path 取状态
   */
  const testStates = ref({})
  const testDetails = ref({})

  /**
   * 按分组切好、再按 `section` 分小节 —— 界面直接遍历（顺序由后端清单决定）
   * 基础模式**只显示必要配置**（`advanced` 为假的项）。
   * 「改过/覆盖过的项也塞进基础模式」这个念头已经砍掉：它会把"基础"悄悄变成"全部"，
   * 使用者就会问"为什么基础里还有每条间隔"。它们在哪交给顶栏「高级」上的角标交代。
   */
  const showAdvanced = ref(readStoredAdvanced())
  watch(showAdvanced, (on) => {
    try {
      window.localStorage.setItem(ADVANCED_KEY, on ? '1' : '0')
    } catch {
      /* 隐私模式禁用存储：只影响下次打开的默认值 */
    }
  })

  const groups = computed(() => {
    if (!data.value) return []
    const visible = (field) => showAdvanced.value || !field.advanced
    return data.value.groups
      .map((group) => {
        const fields = data.value.fields.filter((field) => field.group === group.key && visible(field))
        const sections = []
        for (const field of fields) {
          const label = field.section || ''
          const last = sections[sections.length - 1]
          if (last && last.label === label) last.fields.push(field)
          else sections.push({ key: `${group.key}-${sections.length}`, label, fields: [field] })
        }
        return { ...group, fields, sections }
      })
      .filter((group) => group.sections.length)
  })

  /** 基础模式下被收起的高级项数量（顶栏用它说明「还有多少没显示」） */
  const hiddenAdvancedCount = computed(() => {
    if (!data.value || showAdvanced.value) return 0
    return data.value.fields.filter((field) => field.advanced && !field.overridden).length
  })

  /** 被收起来的项里，有多少是"改过/覆盖过"的 —— 顶栏角标要给出交代，否则人找不到自己改过什么 */
  const changedInAdvanced = computed(() => {
    if (!data.value || showAdvanced.value) return 0
    return data.value.fields.filter(
      (field) => field.advanced && (field.overridden || field.path in draft.value),
    ).length
  })

  /** 模型列表：懒加载（点开模型下拉时才向接口要；换供应商后自动刷新） */
  const models = ref([])
  const modelsLoading = ref(false)
  /** 当前接口地址（草稿优先）—— 供应商/模型的候选都按它取 */
  const aiBaseUrl = computed(() => {
    if ('ai.baseUrl' in draft.value) return String(draft.value['ai.baseUrl'] || '')
    return String(fieldByPath.value.get('ai.baseUrl')?.value || '')
  })
  /** 这台机器上填没填 Key（草稿优先；后端只回「配没配」不回明文） */
  const aiKeyConfigured = computed(() => {
    if ('ai.apiKey' in draft.value) return String(draft.value['ai.apiKey'] || '').trim().length > 0
    return Boolean(fieldByPath.value.get('ai.apiKey')?.hasValue)
  })
  /** 供应商清单：走社区维护的目录（models.dev，200+ 家），取不到就用后端内置的那份 */
  const providers = ref([])
  async function loadProviders() {
    try {
      const res = await fetchAiProviders()
      providers.value = res?.providers ?? []
    } catch {
      // 目录站不可达：退回内置清单（界面照常可用）
      providers.value = []
    }
    if (!providers.value.length) providers.value = data.value?.aiProviders ?? []
  }

  const normalizeBase = (url) => String(url || '').trim().toLowerCase().replace(/\/+$/, '')
  /** 当前地址命中的供应商预设（拿它自带的模型名当"还没填 Key 时的候选"） */
  const matchedProvider = computed(() => providers.value.find((p) => normalizeBase(p.baseUrl) === normalizeBase(aiBaseUrl.value)))
  const providerModels = computed(() => matchedProvider.value?.models ?? [])

  /**
   * 选提供商 = 写「提供商名」（界面显示）+「接口地址」（真正生效），
   * 并把**下面的参数一起补齐**：模型不在这一家的列表里就换成它推荐的那个
   * （优先 `chat` / `flash` / `mini` 这类适合批量分类的；否则取第一个）。
   * 选「自定义」时 `baseUrl` 为空 → 只记名字，地址留给使用者自己填。
   */
  function pickProvider({ name, baseUrl, models: modelList }) {
    setValue('ai.provider', name || '')
    if (!baseUrl) return
    setValue('ai.baseUrl', baseUrl)

    const list = Array.isArray(modelList) ? modelList : []
    const current = String(
      'ai.model' in draft.value ? draft.value['ai.model'] : fieldByPath.value.get('ai.model')?.value || '',
    ).trim()
    if (list.length && !list.includes(current)) {
      const preferred =
        list.find((m) => /chat/i.test(m)) || list.find((m) => /flash|mini|turbo/i.test(m)) || list[0]
      setValue('ai.model', preferred)
    }
  }


  async function loadModels() {
    if (modelsLoading.value) return
    modelsLoading.value = true
    // 先用目录里的候选（不需要 Key 也能看到模型名），再用接口实时结果覆盖
    models.value = providerModels.value
    try {
      const res = await fetchAiModels(aiBaseUrl.value)
      if (res?.models?.length) models.value = res.models
    } catch {
      // 未配置 / 上游取不到：保留目录候选（或空），回落成纯手动输入
    } finally {
      modelsLoading.value = false
    }
  }

  const dirtyPaths = computed(() => Object.keys(draft.value))
  const dirtyCount = computed(() => dirtyPaths.value.length)
  /** path → 字段（含后端给的当前生效值） */
  const fieldByPath = computed(() => {
    const map = new Map()
    for (const field of data.value?.fields ?? []) map.set(field.path, field)
    return map
  })
  const allPaths = computed(() => (data.value?.fields ?? []).map((field) => field.path))

  /* 换供应商（或手改接口地址）→ **自动**去拉那家的模型列表
     -------------------------------------------------------------------------
     为什么不再要求「保存 → 点模型 → 刷新」：选了供应商却还看到上一家的模型，
     是最容易让人配错模型名的一种界面。这里只等 600ms（防止一边打字一边发请求），
     然后按**草稿里的地址**去取 —— 没保存也能拿到。 */
  let modelsTimer = null
  watch(aiBaseUrl, (next) => {
    if (!next) return
    clearTimeout(modelsTimer)
    modelsTimer = setTimeout(() => loadModels(), 600)
  })

  /** 某一行当前该显示的值：改过就用草稿，否则用后端值 */
  const valueOf = (field) => (field.path in draft.value ? draft.value[field.path] : field.value)
  const isDirty = (field) => field.path in draft.value
  /** 密钥行：改过 / 原来就有值 */
  const secretStateOf = (field) => ({
    dirty: isDirty(field),
    hasValue: Boolean(field.hasValue),
    preview: field.preview || '',
  })

  async function load() {
    loading.value = true
    error.value = null
    try {
      data.value = await fetchSettings()
      // 供应商目录单独拉（200+ 家，不能拖慢设置页首屏）
      loadProviders()
    } catch (err) {
      error.value = err
    } finally {
      loading.value = false
    }
  }

  function setValue(path, value) {
    const field = data.value?.fields.find((item) => item.path === path)
    // 改回原值 = 取消这次改动（开关点两下就回到「未改动」，不再挂着一个点不动的「撤销」）
    if (field && sameValue(value, field.value)) {
      const next = { ...draft.value }
      delete next[path]
      draft.value = next
      return
    }
    draft.value = { ...draft.value, [path]: value }
  }

  function revert(path) {
    const next = { ...draft.value }
    delete next[path]
    draft.value = next
  }

  function revertAll() {
    draft.value = {}
  }

  /**
   * 保存：把要保存的字段**当前值**整份写库
   * ---------------------------------------------------------------------------
   * 不是只写「改过的项」。原因：只写 diff 时，点一次保存往往只落一两个键，
   * 打开数据库的人会以为「设置根本没存进去」（事实上别的项还挂在默认值/环境变量上）。
   * 全量提交后：点过保存的分组，整组配置都在库里，备份/搬迁直接拿到整份。
   * 代价是这一组的值被固化（之后改代码默认值对这几项不再生效）——各行都有「还原默认」，
   * 那是把覆盖删掉、回落到代码默认值的出口。
   * 密钥例外：它不回显（当前值永远是 null），没改过就**不提交** ——
   * 提交 null 等于把已经配好的 key 删掉。
   */
  function snapshotOf(paths) {
    const out = {}
    for (const path of paths) {
      const field = fieldByPath.value.get(path)
      if (!field) continue
      if (path in draft.value) {
        out[path] = draft.value[path]
        continue
      }
      if (field.type === 'secret') continue
      // 空值不提交：没配过的项（如 qBittorrent 地址）本来就没值，
      // 提交上去会被当成「要设为空」而校验失败；跳过它才是「跟随默认值」的本意
      if (field.value === null || field.value === undefined || field.value === '') continue
      out[path] = field.value
    }
    return out
  }

  async function save(paths, key = '') {
    const target = paths?.length ? snapshotOf(paths) : snapshotOf(allPaths.value)
    if (!Object.keys(target).length) return undefined
    saving.value = true
    savingKey.value = key
    message.value = ''
    try {
      const res = await saveSettings(target)
      // 只清掉「这次保存的那些项」：别的卡片还没保存的改动要留着
      const next = { ...draft.value }
      for (const path of Object.keys(target)) delete next[path]
      draft.value = next

      data.value = res.settings
      message.value = key ? `${key} 已保存 ${res.applied.length} 项` : `已保存 ${res.applied.length} 项`
      // 按钮变「保存成功」两秒（旧版就是这个反馈）
      savedKey.value = key || '__all__'
      clearTimeout(savedTimer)
      savedTimer = setTimeout(() => {
        savedKey.value = ''
      }, 2000)
    } catch (err) {
      // 校验失败时后端会带 detail.errors（哪一项、为什么），直接给人看
      const detail = err?.detail?.errors?.map((e) => `${e.path}：${e.message}`).join('；')
      message.value = detail ? `保存失败 —— ${detail}` : `保存失败：${err.message}`
      error.value = err
    } finally {
      saving.value = false
      savingKey.value = ''
    }
    return message.value
  }

  /** 还原某一项为默认（立刻请求后端，不等「保存」） */
  async function resetOne(path) {
    revert(path)
    saving.value = true
    try {
      const res = await resetSettings([path])
      data.value = res.settings
      message.value = `已还原 ${path} 为默认值`
    } catch (err) {
      message.value = `还原失败：${err.message}`
      error.value = err
    } finally {
      saving.value = false
    }
  }

  async function resetAll() {
    revertAll()
    saving.value = true
    try {
      const res = await resetSettings([])
      data.value = res.settings
      message.value = '已全部还原为代码默认值'
    } catch (err) {
      message.value = `还原失败：${err.message}`
      error.value = err
    } finally {
      saving.value = false
    }
  }

  /**
   * 导入一份导出的 JSON
   * @param {object} payload 解析后的对象
   * @param {'merge'|'replace'} mode
   */
  async function importPayload(payload, mode = 'merge') {
    saving.value = true
    try {
      const res = await importSettings(payload, mode)
      data.value = res.settings
      draft.value = {}
      const ignored = res.ignored.length ? `，忽略 ${res.ignored.length} 个未知项` : ''
      message.value = `已导入 ${res.applied.length} 项（${mode === 'replace' ? '覆盖' : '合并'}）${ignored}`
    } catch (err) {
      const detail = err?.detail?.errors?.map((e) => `${e.path}：${e.message}`).join('；')
      message.value = detail ? `导入失败 —— ${detail}` : `导入失败：${err.message}`
      error.value = err
    } finally {
      saving.value = false
    }
  }

  /**
   * 「一行测试」的结果文案（成功 / 失败都写成一整句，耗时统一 `1s 234ms`）
   */
  function describeTest(res) {
    return res.ok
      ? `成功 · ${res.detail ? `${res.detail} · ` : ''}${formatDuration(res.ms)}`
      : `失败：${res.reason || `HTTP ${res.status}`}（${formatDuration(res.ms)}）`
  }

  /**
   * 多源列表里**单独测某一条**（Mikan / Bangumi 的某个地址）
   * -----------------------------------------------------------------------
   * 为什么需要：一键全测只会说"1/2 可用"，而到底是哪条坏、坏在哪，得逐条看。
   * 结果按 `path + url` 记，切走再回来还在。
   * @param {string} path 字段路径
   * @param {string} url 该行的地址
   */
  const rowTests = ref({})
  async function testRow(path, url) {
    const key = String(url || '').trim()
    if (!key) return
    const put = (state, detail, ms) => {
      rowTests.value = {
        ...rowTests.value,
        [path]: { ...(rowTests.value[path] || {}), [key]: { state, detail, ms: ms ?? null } },
      }
    }
    put('testing', '正在连接…')
    try {
      const res = await testSetting(path, key)
      put(res.ok ? 'success' : 'error', describeTest(res), res.ms)
    } catch (err) {
      put('error', err.message)
    }
  }

  /**
   * 测试某个地址通不通（设置页每行右边的插头按钮）
   * 用「输入框里的值」测（还没保存也能先试）；结果状态供按钮显示插头/转圈/对勾/叉
   * @param {string} path
   * @param {string} value
   */
/**
 * 「测试全部」= **逐条并发**，谁先回来谁先显示
 * ---------------------------------------------------------------------------
 * 为什么不复用后端那个批量接口：它是**串行**测完才一次性返回，
 * 结果是"点了之后一片空白，两秒后所有行一起变"。这里每个地址各发一次请求，
 * 谁先通谁先出 ms，行上的转圈也能各自走完。
 */
async function testEach(path, urls) {
  const startedAt = Date.now()
  testStates.value = { ...testStates.value, [path]: 'testing' }
  testDetails.value = { ...testDetails.value, [path]: '正在逐个测试…' }

  const pending = {}
  for (const url of urls) pending[url] = { state: 'testing', detail: '正在连接…', ms: null }
  rowTests.value = { ...rowTests.value, [path]: { ...(rowTests.value[path] || {}), ...pending } }

  const results = []
  await Promise.all(
    urls.map(async (url) => {
      const put = (entry) => {
        rowTests.value = {
          ...rowTests.value,
          [path]: { ...(rowTests.value[path] || {}), [url]: entry },
        }
      }
      try {
        const res = await testSetting(path, url)
        put({
          state: res.ok ? 'success' : 'error',
          detail: describeTest(res),
          ms: res.ms ?? null,
        })
        results.push({ base: url, ...res })
      } catch (err) {
        put({ state: 'error', detail: err.message, ms: null })
        results.push({ base: url, ok: false, status: 0, ms: 0, reason: err.message })
      }
    }),
  )

  const passed = results.filter((r) => r.ok).length
  const ok = passed > 0
  testStates.value = { ...testStates.value, [path]: ok ? 'success' : 'error' }
  testDetails.value = {
    ...testDetails.value,
    [path]: ok
      ? `成功 · ${passed}/${urls.length} 通过 · 累计 ${formatDuration(Date.now() - startedAt)}`
      : `失败：${urls.length} 个地址都不通`,
  }
  return { ok, status: 0, ms: Date.now() - startedAt, detail: `${passed}/${urls.length} 通过`, sources: results }
}

/**
 * 测试某个地址通不通（设置页每行右边的插头按钮）
 * 用「输入框里的值」测（还没保存也能先试）；结果状态供按钮显示插头/转圈/对勾/叉
 * @param {string} path
 * @param {string} value
 */
async function testField(path, value) {
  if (testStates.value[path] === 'testing') return undefined

  const urls = String(value || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  // 多源列表：逐条并发，结果各自落到自己的行上
  if (urls.length > 1) return testEach(path, urls)

  testStates.value = { ...testStates.value, [path]: 'testing' }
  testDetails.value = { ...testDetails.value, [path]: '正在连接…' }

  try {
    const res = await testSetting(path, value)
    testStates.value = { ...testStates.value, [path]: res.ok ? 'success' : 'error' }
    // 成功就说「成功 + 通过条数 + 耗时」（绿），别把 200 这种状态码甩给使用者看；
    // 失败才需要具体原因（带上状态码，方便排错）。耗时统一成 `1s 234ms` 这种写法。
    testDetails.value = { ...testDetails.value, [path]: describeTest(res) }

    /* 单条也要把结果落到"那一行"上（有些 list 字段只有一条地址走这条路径） */
    if (Array.isArray(res.sources) && res.sources.length) {
      const rows = {}
      for (const item of res.sources) {
        rows[item.base] = {
          state: item.ok ? 'success' : 'error',
          detail: item.ok
            ? `成功 · ${formatDuration(item.ms)}`
            : `失败：${item.reason || `HTTP ${item.status}`}（${formatDuration(item.ms)}）`,
          ms: item.ms ?? null,
        }
      }
      rowTests.value = { ...rowTests.value, [path]: { ...(rowTests.value[path] || {}), ...rows } }
    }
    return res
  } catch (err) {
    testStates.value = { ...testStates.value, [path]: 'error' }
    testDetails.value = { ...testDetails.value, [path]: err.message }
    return undefined
  }
}

  /**
   * 导出并下载
   * 用临时 <a download> 而不是 window.open：后者会被弹窗拦截器吃掉，
   * 而且这样能把「带密钥」与「脱敏」两份文件区分开（后端已在文件名里标了 with-secrets）
   */
  function exportFile({ includeSecrets = false } = {}) {
    const a = document.createElement('a')
    a.href = exportUrl(includeSecrets)
    a.download = ''
    document.body.appendChild(a)
    a.click()
    a.remove()
    message.value = includeSecrets ? '已导出（含密钥，注意别外传）' : '已导出（不含密钥）'
  }

  return {
    data,
    groups,
    showAdvanced,
    hiddenAdvancedCount,
    changedInAdvanced,
    models,
    modelsLoading,
    loadModels,
    providers,
    loadProviders,
    providerModels,
    pickProvider,
    aiBaseUrl,
    aiKeyConfigured,
    rowTests,
    testRow,
    loading,
    saving,
    savingKey,
    savedKey,
    unchangedKey,
    markUnchanged,
    error,
    message,
    draft,
    dirtyCount,
    dirtyPaths,
    valueOf,
    isDirty,
    secretStateOf,
    testStates,
    testDetails,
    testField,
    setValue,
    revert,
    revertAll,
    load,
    save,
    resetOne,
    resetAll,
    importPayload,
    exportFile,
  }
}
