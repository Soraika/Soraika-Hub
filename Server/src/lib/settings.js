/**
 * 设置项清单与校验 —— 「哪些能改、怎么校验、怎么落到 config」的唯一来源
 * ---------------------------------------------------------------------------
 * 一份清单三处复用：设置页渲染表单、PUT 时校验、导出/导入时校验格式 —— 不三处各写一遍。
 *
 * 覆盖模型：**只存改过的项**。没改过的项继续用代码默认值（`config.js` 的 `defaultConfig` 快照）；
 * 某项传 `null` 就删掉覆盖、回落到默认值 —— 这就是「重置为默认」的实现。
 * 存库/路由分别在 db/settings.js 与 api/pages/settings.js，这里只做纯逻辑（不碰 SQL、不发请求）。
 *
 * restart=true 的含义：那几项是**启动时读进局部变量**的（端口、落盘目录、缓存实例的 TTL…），
 * 改了要重启对应进程才生效 —— 设置页会显式提示，别让人以为保存了没用。
 */
import { config, defaultConfig } from '../config.js'
import { fail } from './errors.js'

/**
 * 分组顺序 = 设置页的显示顺序；每个分组里的字段再按 `section`（小节）聚块 ——
 * 27 项平铺成一条长龙就是「表单」，分组 + 小节才是「有结构的内容」（旧版用 .sub-title 做这件事）。
 */
export const SETTINGS_GROUPS = [
  { key: 'sources', label: '数据源', hint: '排期来自 Mikan，评分与档案来自 Bangumi' },
  { key: 'ai', label: 'AI', hint: '资源标签与集数解析，留空 Key 即关闭' },
  { key: 'worker', label: '后台任务', hint: '档案补齐与今年番剧的每日更新' },
  { key: 'cache', label: '缓存与图片', hint: '首页排期缓存、海报出图与浏览器缓存' },
  { key: 'qb', label: '下载', hint: 'qBittorrent，下载功能接入后才用得上' },
]

/**
 * 字段清单。type 决定控件与校验：
 *   text（单行文本）/ secret（密钥，只写不回显）/ url / number / boolean / time（HH:MM）
 * 字段属性：
 *   · `advanced`  收进卡片里的「微调参数」折叠块。**判断标准只有一条**：
 *                 不填（或不动）会跑不起来 / 必须按自己环境改的 → 常显（必要）；
 *                 有合理默认值、改它属于"调参"的 → 折叠。
 *                 例：AI 凭据、站点地址、qB 凭据是必要项；超时、TTL、并发、UA、落盘目录都是调参。
 *                 （这条标准被 verify-settings 的断言钉住：基础项一旦超过 8 个就会红。）
 *   · `format`    特殊展示语义，'duration' 表示时长（前端换算成「30 分钟」这类可读文案）
 *   · `unit`      单位（校验与换算的基准）
 *   · `restart`   启动时读取，保存后需重启进程才生效
 *   · `placeholder` 输入框的格式示例（没有默认值的字段才需要）
 *
 * hint 写法约定：只写「是什么 / 怎么用」，必要时补「为什么」；不写厂商名、不写命令、
 * 不写对开发者才成立的信息（这类信息属于文档，不属于界面）。
 */
export const SETTINGS_FIELDS = [
  // ── 数据源 ──
  { path: 'mikan.base', env: 'MIKAN_BASE_URL', group: 'sources', section: 'Mikan 排期源', label: '站点地址', type: 'url', hint: '排期来源，可换成可用镜像' },
  { path: 'mikan.timeoutMs', env: 'MIKAN_TIMEOUT_MS', group: 'sources', section: 'Mikan 排期源', label: '请求超时', type: 'number', unit: 'ms', format: 'duration', min: 1000, advanced: true },

  { path: 'bgm.base', env: 'BGM_API_BASE', group: 'sources', section: 'Bangumi 评分源', label: '接口地址', type: 'url', advanced: true, hint: '评分、标签与简介来源' },
  { path: 'bgm.token', env: 'BGM_TOKEN', group: 'sources', section: 'Bangumi 评分源', label: 'Token', type: 'secret', advanced: true, hint: '官方接口要求时填写' },
  { path: 'bgm.userAgent', env: 'BGM_USER_AGENT', group: 'sources', section: 'Bangumi 评分源', label: 'User-Agent', type: 'text', hint: '官方接口要求携带', advanced: true },
  { path: 'bgm.timeoutMs', env: 'BGM_TIMEOUT_MS', group: 'sources', section: 'Bangumi 评分源', label: '请求超时', type: 'number', unit: 'ms', format: 'duration', min: 1000, advanced: true },

  // ── AI ──
  { path: 'ai.baseUrl', env: 'AI_BASE_URL', group: 'ai', section: '接口与凭据', label: '接口地址', type: 'url', providers: true },
  { path: 'ai.apiKey', env: 'AI_API_KEY', group: 'ai', section: '接口与凭据', label: 'API Key', type: 'secret', hint: '留空即关闭 AI 功能' },
  { path: 'ai.model', env: 'AI_MODEL', group: 'ai', section: '接口与凭据', label: '模型', type: 'text', models: true },
  { path: 'ai.maxTokens', env: 'AI_MAX_TOKENS', group: 'ai', section: '接口与凭据', label: '最大输出', type: 'number', unit: 'token', min: 64, advanced: true },

  { path: 'ai.timeoutMs', env: 'AI_TIMEOUT_MS', group: 'ai', section: '解析参数', label: '单次超时', type: 'number', unit: 'ms', format: 'duration', min: 1000, advanced: true },
  { path: 'ai.maxTitles', env: 'AI_MAX_TITLES', group: 'ai', section: '解析参数', label: '单批上限', type: 'number', unit: '条', min: 1, advanced: true, hint: '超出会切多批跑完，不丢数据' },
  { path: 'ai.tagCacheTtlMs', env: 'AI_TAG_CACHE_TTL_MS', group: 'ai', section: '解析参数', label: '标签缓存', type: 'number', unit: 'ms', format: 'duration', min: 1000, advanced: true, hint: '相同资源的解析结果复用时长' },
  { path: 'ai.episodeCacheTtlMs', env: 'AI_EPISODE_CACHE_TTL_MS', group: 'ai', section: '解析参数', label: '集数缓存', type: 'number', unit: 'ms', format: 'duration', min: 1000, advanced: true, hint: '改完立即生效，不用重启' },

  // ── 后台任务 ──
  { path: 'worker.inline', env: 'WORKER_INLINE', group: 'worker', section: '调度', label: '跟随服务进程', type: 'boolean', restart: true, advanced: true, hint: '关闭后由独立进程执行' },
  { path: 'worker.dailyAt', env: 'WORKER_DAILY_AT', group: 'worker', section: '调度', label: '每日更新时刻', type: 'time', hint: '每天在这个时间刷新当年档案' },
  { path: 'worker.gapMs', env: 'WORKER_GAP_MS', group: 'worker', section: '调度', label: '每条间隔', type: 'number', unit: 'ms', format: 'duration', min: 0, advanced: true, hint: '间隔过小可能被上游限流' },
  { path: 'worker.idleMs', env: 'WORKER_IDLE_MS', group: 'worker', section: '调度', label: '空闲休眠', type: 'number', unit: 'ms', format: 'duration', min: 100, advanced: true },
  { path: 'worker.staleYear', env: 'WORKER_STALE_YEAR', group: 'worker', section: '调度', label: '覆盖年份', type: 'number', unit: '年', allowNull: true, advanced: true, hint: '留空表示仅当年，0 表示全部年份' },

  { path: 'worker.missLimit', env: 'WORKER_MISS_LIMIT', group: 'worker', section: '失败退避', label: 'bgmId 重试上限', type: 'number', unit: '次', min: 1, advanced: true },
  /* 注意单位：这一项的值是**小时**，不是毫秒 —— 不能挂 `format: 'duration'`（那是「值是毫秒」的意思），
     否则界面把它按毫秒显示（24 用时 → 显示成「24ms」），提交时还会被当毫秒换算回一个天文数字。 */
  { path: 'worker.missRetryHours', env: 'WORKER_MISS_RETRY_HOURS', group: 'worker', section: '失败退避', label: '放弃后重试间隔', type: 'number', unit: '小时', min: 0, advanced: true },

  // ── 缓存与图片 ──
  { path: 'cacheTtlMs', env: 'CACHE_TTL_MS', group: 'cache', section: '数据缓存', label: '排期缓存', type: 'number', unit: 'ms', format: 'duration', min: 1000, advanced: true, hint: '缓存期内直接读库，不回源' },
  { path: 'seasonLimit', env: 'SEASON_LIMIT', group: 'cache', section: '数据缓存', label: '单季入库上限', type: 'number', unit: '条', min: 1, advanced: true },
  { path: 'image.dir', env: 'IMAGE_CACHE_DIR', group: 'cache', section: '海报图片', label: '落盘目录', type: 'text', restart: true, advanced: true, hint: '相对服务端工作目录' },
  /* 同上：这一项是**秒**（写进 Cache-Control 的 max-age），不是毫秒 —— 不挂 `format: 'duration'` */
  { path: 'image.maxAgeSec', env: 'IMAGE_MAX_AGE_SEC', group: 'cache', section: '海报图片', label: '浏览器缓存', type: 'number', unit: '秒', min: 0, advanced: true },

  // ── 下载 ──
  { path: 'qb.base', env: 'QB_BASE_URL', group: 'qb', section: 'qBittorrent', label: '地址', type: 'url', placeholder: 'http://127.0.0.1:8080' },
  { path: 'qb.apiKey', env: 'QB_API_KEY', group: 'qb', section: 'qBittorrent', label: 'API Key', type: 'secret' },
]

/**
 * 常见 OpenAI 兼容供应商 —— 设置页的「供应商」下拉用它们一键填好接口地址。
 * 只提供地址；模型列表由 `/api/ai/models` 从接口实时获取（不在代码里写死，避免过期）。
 */
export const AI_PROVIDERS = [
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  { name: 'Moonshot', baseUrl: 'https://api.moonshot.cn/v1' },
  { name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { name: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1' },
  { name: 'Ollama（本地）', baseUrl: 'http://127.0.0.1:11434/v1' },
  { name: 'LM Studio（本地）', baseUrl: 'http://127.0.0.1:1234/v1' },
]

const FIELD_BY_PATH = new Map(SETTINGS_FIELDS.map((f) => [f.path, f]))

/**
 * 只能在启动时定的项：界面里**只读展示**，不做编辑 ——
 * 端口改错会连不上自己，库文件改错会连到另一个库，都属于「改完要在终端解决」的事。
 */
export const READONLY_FIELDS = [
  { path: 'port', env: 'PORT', label: '监听端口', hint: '启动参数，改完重启进程' },
  { path: 'dbFile', env: 'DB_FILE', label: '数据库文件', hint: '启动参数，改完重启进程' },
]

const getAtPath = (obj, path) => path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj)
function setAtPath(obj, path, value) {
  const keys = path.split('.')
  const last = keys.pop()
  const target = keys.reduce((acc, key) => acc[key], obj)
  target[last] = value
}

/* ── 校验 ────────────────────────────────────────────────────────────────── */

const isHttpUrl = (v) => {
  try {
    const url = new URL(v)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * 校验单个值 → `{ ok: true, value }` 或 `{ ok: false, message }`
 * 空值语义：`allowNull` 的字段接受 null（如「每日更新覆盖年份留空 = 当年」）；
 * 其余字段空串视为非法。数字统一转 Number（前端传字符串也认）。
 */
export function validateValue(field, raw) {
  if (raw === null || raw === undefined || raw === '') {
    if (field.allowNull) return { ok: true, value: null }
    return { ok: false, message: `${field.label} 不能为空` }
  }

  switch (field.type) {
    case 'boolean': {
      const truthy = raw === true || raw === 'true' || raw === 1 || raw === '1'
      const falsy = raw === false || raw === 'false' || raw === 0 || raw === '0'
      if (truthy || falsy) return { ok: true, value: truthy }
      return { ok: false, message: `${field.label} 只能是 true / false` }
    }
    case 'number': {
      const value = Number(raw)
      if (!Number.isFinite(value)) return { ok: false, message: `${field.label} 需要是数字` }
      if (field.min !== undefined && value < field.min) {
        return { ok: false, message: `${field.label} 不能小于 ${field.min}` }
      }
      if (field.max !== undefined && value > field.max) {
        return { ok: false, message: `${field.label} 不能大于 ${field.max}` }
      }
      return { ok: true, value }
    }
    case 'time': {
      const value = String(raw).trim()
      return /^([01]?\d|2[0-3]):[0-5]\d$/.test(value)
        ? { ok: true, value }
        : { ok: false, message: `${field.label} 需要是 HH:MM（24 小时制），例如 04:00` }
    }
    case 'url': {
      const value = String(raw).trim()
      if (!isHttpUrl(value)) {
        return { ok: false, message: `${field.label} 需要是 http(s):// 开头的完整地址` }
      }
      // 结尾斜杠去掉，避免拼出 //path（与 config.js 的 trimSlash 一致）
      return { ok: true, value: value.replace(/\/+$/, '') }
    }
    default: {
      // text / secret
      const value = String(raw).trim()
      if (value.length > 500) return { ok: false, message: `${field.label} 太长了（上限 500 字）` }
      return { ok: true, value }
    }
  }
}

/* ── 应用 ────────────────────────────────────────────────────────────────── */

/**
 * 把 `{ path: value }` 写进运行时 config（`null` = 删掉覆盖、回落到代码默认值）
 * 只改内存；落库在 api/pages/settings.js —— 本层不碰 SQL（分层：lib 不依赖 db）
 */
export function applyValues(values = {}) {
  for (const [path, value] of Object.entries(values)) {
    if (!FIELD_BY_PATH.has(path)) continue
    setAtPath(config, path, value === null ? getAtPath(defaultConfig, path) : value)
  }
  // 派生项：AI 是否可用只看有没有 key —— 改完 key 要立刻反映到 /api/health 与设置页
  config.ai.enabled = Boolean(config.ai.apiKey)
  return Object.keys(values).length
}

/**
 * 全部字段回落到代码默认值
 * 「应用库里的覆盖项」之前先调它一次，保证重置真的干净 ——
 * 否则删掉某行覆盖后，内存里还留着上一次的值（库里已经没有它了）。
 */
export function resetToDefaults() {
  for (const field of SETTINGS_FIELDS) {
    setAtPath(config, field.path, getAtPath(defaultConfig, field.path))
  }
  config.ai.enabled = Boolean(config.ai.apiKey)
}

/** 一次改多项：先全校验，有一项不过就整批拒绝（不做「改一半」） */
export function applyPatch(values = {}) {
  const errors = []
  const clean = {}
  for (const [path, raw] of Object.entries(values)) {
    const field = FIELD_BY_PATH.get(path)
    if (!field) {
      errors.push({ path, message: `未知配置项 ${path}` })
      continue
    }
    const result = validateValue(field, raw)
    if (!result.ok) errors.push({ path, message: result.message })
    else clean[path] = result.value
  }
  if (errors.length) throw fail('BAD_REQUEST', '有配置项没通过校验', { errors })
  applyValues(clean)
  return { applied: Object.keys(clean), values: clean }
}

/* ── 读当前值 / 给界面用 ─────────────────────────────────────────────────── */

/** 当前生效值（secret 默认不出门） */
export function currentValues({ includeSecrets = false } = {}) {
  const out = {}
  for (const field of SETTINGS_FIELDS) {
    if (field.type === 'secret' && !includeSecrets) continue
    const value = getAtPath(config, field.path)
    out[field.path] = value === undefined ? null : value
  }
  return out
}

/** 密钥的「配没配 + 打码预览」—— 界面要能显示状态，但绝不回明文 */
export function secretState(path) {
  const value = String(getAtPath(config, path) ?? '')
  if (!value) return { hasValue: false, preview: '' }
  return { hasValue: true, preview: `${value.slice(0, 3)}…${value.slice(-4)}` }
}

/** 给设置页的清单：字段定义 + 当前值 + **默认值**（placeholder 用）+ 是否被覆盖过 */
export function fieldsForUi(overridden = []) {
  return SETTINGS_FIELDS.map((field) => {
    const base = {
      ...field,
      overridden: overridden.includes(field.path),
      /** 代码默认值 —— 输入框空着时用它当 placeholder（「默认值优先，能测不猜」） */
      default: getAtPath(defaultConfig, field.path) ?? null,
    }
    if (field.type === 'secret') return { ...base, value: null, ...secretState(field.path) }
    return { ...base, value: getAtPath(config, field.path) ?? null }
  })
}

/* ── 导出 / 导入（分享给别人就用这份 JSON）──────────────────────────────── */

export const EXPORT_KIND = 'soraikahub-settings'
export const EXPORT_VERSION = 1

/** 导出当前生效值（含 .env 里配的）—— 对方导入后行为才一致 */
export function buildExport({ includeSecrets = false } = {}) {
  return {
    app: 'soraika-hub',
    kind: EXPORT_KIND,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    includesSecrets: includeSecrets,
    values: currentValues({ includeSecrets }),
  }
}

/**
 * 解析导入的 JSON
 *  · 每一项都校验；**值不合法就整包拒绝** —— 半吊子导入（一半新值一半旧值）比直接失败更难排查
 *  · 未知配置项只**忽略并回报**，不拒绝整包：跨版本迁移时旧文件里多几个键不该卡住
 * @returns {{ values: Record<string, any>, ignored: string[] }}
 */
export function parseImport(payload) {
  if (!payload || typeof payload !== 'object') throw fail('BAD_REQUEST', '导入内容需要是 JSON 对象')
  if (payload.kind !== EXPORT_KIND) {
    throw fail('BAD_REQUEST', `这不是 SoraikaHub 的设置文件（kind=${payload.kind ?? '空'}）`)
  }
  if (Number(payload.version) > EXPORT_VERSION) {
    throw fail('BAD_REQUEST', `设置文件版本 ${payload.version} 比当前程序新，请先升级程序`)
  }
  const raw = payload.values
  if (!raw || typeof raw !== 'object') throw fail('BAD_REQUEST', '设置文件里没有 values')

  const errors = []
  const ignored = []
  const values = {}
  for (const [path, value] of Object.entries(raw)) {
    const field = FIELD_BY_PATH.get(path)
    if (!field) {
      ignored.push(path)
      continue
    }
    const result = validateValue(field, value)
    if (!result.ok) errors.push({ path, message: result.message })
    else values[path] = result.value
  }
  if (errors.length) throw fail('BAD_REQUEST', '导入的设置里有不合法的项', { errors })

  return { values, ignored }
}
