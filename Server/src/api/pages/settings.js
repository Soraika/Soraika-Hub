/**
 * 设置聚合层 —— 把「库里的覆盖项」「运行时 config」「导出/导入」接在一起
 * ---------------------------------------------------------------------------
 * 这是唯一同时碰三样的地方：db/settings.js（存）、lib/settings.js（校验与应用）、config（生效）。
 * 启动时 index.js 调 loadStoredSettings()：先回落 .env 快照，再套用库里的覆盖项 ——
 * 所以改完设置**不用重启**即生效（改的就是同一个 config 对象），这也是「store 在库里」的好处。
 */
import { config, defaultConfig } from '../../config.js'
import { clearSettings, listSettings, setSettings, settingsMeta } from '../../db/settings.js'
import { fail } from '../../lib/errors.js'
import { logger } from '../../lib/logger.js'
import {
  AI_PROVIDERS,
  READONLY_FIELDS,
  SETTINGS_FIELDS,
  SETTINGS_GROUPS,
  applyPatch,
  applyValues,
  buildExport,
  currentValues,
  fieldsForUi,
  parseImport,
  resetToDefaults,
  validateValue,
} from '../../lib/settings.js'

/** 回落代码默认值 → 套用库里的覆盖项（读库/重置/导入后都走这条路径，保证内存与库一致） */
function applyStored() {
  resetToDefaults()
  return applyValues(listSettings())
}

/**
 * 静默补齐：把「库里还没有的字段」用当前生效值写进去
 * ---------------------------------------------------------------------------
 * 为什么需要：设置是**覆盖模型**（只存用户改过的项），所以刚装好时打开库只有零星几条，
 * 看起来像「设置根本没存进数据库」。这里在启动时补一次全量 —— 库里从此能看到整份配置，
 * 而使用者什么都不用做，界面上也没有任何提示（配置落在哪里不该是使用者的负担）。
 *
 * 只补不覆盖：已存在的键（用户改过的、或上一次补的）保持不动。
 * 想回到默认值就走设置页的「还原默认」与「全部还原」——那是把键删掉、回落到 .env 的出口。
 * 密钥不参与（它不回显，本就不该由系统替用户写一份）。
 */
export function fillMissingSettings({ log = logger } = {}) {
  const stored = listSettings()
  const current = currentValues() // 当前生效值（secret 不在里面）
  const patch = {}
  for (const field of SETTINGS_FIELDS) {
    if (field.path in stored) continue
    const value = current[field.path]
    if (value === undefined || value === null || value === '') continue
    patch[field.path] = value
  }
  const filled = Object.keys(patch)
  if (filled.length) {
    setSettings(patch)
    log.info({ filled: filled.length }, 'settings.fill ok')
  }
  return filled
}

/**
 * 摘掉「已知不可用」的镜像地址（升级迁移）
 * ---------------------------------------------------------------------------
 * 旧版本的默认值是 `mikanime.tv + mikanani.me`，而 `mikanani.me` 实测**完全不响应**
 * （8 秒超时）：主站一抖，故障切换就去撞它，每次失败多等 20 秒 ——
 * 用户看到的就是"首页切季一直转圈 / 打不开"。
 * 存进库里的旧值不会跟着代码默认值变，所以这里主动清一次（只清这一个已知死地址，
 * 用户自己加的其它地址不动）。清完如果空了就回落新默认。
 */
const DEAD_MIRRORS = ['https://mikanani.me']

function pruneDeadMirrors({ log = logger } = {}) {
  const list = Array.isArray(config.mikan.bases) ? config.mikan.bases : []
  const kept = list.filter((base) => !DEAD_MIRRORS.includes(String(base).replace(/\/+$/, '')))
  if (kept.length === list.length) return
  const next = kept.length ? kept : [defaultConfig.mikan.bases[0]]
  applyValues({ 'mikan.bases': next })
  setSettings({ 'mikan.bases': next })
  log.info({ removed: list.length - kept.length, next }, 'settings.mirror prune')
}

/** 启动时调用：把库里存过的覆盖项应用上，再静默补齐缺的项 */
export function loadStoredSettings({ log = logger } = {}) {
  const stored = listSettings()
  // 旧版本留下的键（例如改过名的 `mikan.base` → `mikan.bases`）直接清掉，
  // 否则它们会一直挂在 overridden 里、界面上却找不到对应项。
  const known = new Set(SETTINGS_FIELDS.map((f) => f.path))
  const stale = Object.keys(stored).filter((key) => !known.has(key))
  if (stale.length) {
    clearSettings(stale)
    log.info({ stale }, 'settings.prune ok')
  }
  resetToDefaults()
  const count = applyValues(stored)
  if (count) log.info({ count, keys: Object.keys(stored) }, 'settings.load ok')
  fillMissingSettings({ log })
  pruneDeadMirrors({ log })
  return count
}

/** 设置页要的整包：分组、字段（含当前值）、只读项、被覆盖过的项 */
export function getSettings() {
  const meta = settingsMeta()
  const overridden = meta.map((row) => row.key)
  return {
    groups: SETTINGS_GROUPS,
    fields: fieldsForUi(overridden),
    /** 常见供应商预设：设置页的「供应商」下拉用（选了就填好接口地址） */
    aiProviders: AI_PROVIDERS,
    /** 端口 / 库文件这类启动参数：只读展示（改它们要去改 .env 并重启） */
    readonly: READONLY_FIELDS.map((field) => ({ ...field, value: config[field.path] ?? null })),
    overridden,
    updatedAt: meta[0]?.updatedAt ?? null,
  }
}

/**
 * 保存：校验（整批）→ 落库 → 生效
 * @param {Record<string, any>} values `{ path: value }`；`null` = 删掉覆盖、回落到默认
 */
export function updateSettings(values, { log = logger } = {}) {
  const { applied, values: clean } = applyPatch(values) // 校验不过会抛 BAD_REQUEST
  setSettings(clean)
  log.info({ applied }, 'settings.update ok')
  return { applied, settings: getSettings() }
}

/** 重置：paths 为空 = 全部重置（删掉覆盖即回落 .env / 默认值） */
export function resetSettings(paths = [], { log = logger } = {}) {
  const list = Array.isArray(paths) ? paths.filter(Boolean) : []
  const removed = clearSettings(list)
  applyStored()
  log.info({ removed, paths: list.length ? list : 'all' }, 'settings.reset ok')
  return { removed, settings: getSettings() }
}

/** 导出（默认脱敏：不导出任何密钥） */
export const exportSettings = ({ includeSecrets = false } = {}) => buildExport({ includeSecrets })

/* ── 测试连接（设置页每行右边那个插头按钮）───────────────────────────────── */

const TEST_TIMEOUT_MS = 8000
/** AI 要给模型时间"想"，探测也得给宽一点（8 秒对慢模型常常不够） */
const AI_TEST_TIMEOUT_MS = 15000

/**
 * 探测用的应答标记
 * ---------------------------------------------------------------------------
 * 「通」的判定不是「HTTP 200」，而是**模型真的按约定把这句话回出来**：
 * 地址对但 Key 错、模型名不存在、模型不支持对话，都会在这条上露馅。
 * 只回一个短词是有意的 —— 既是完整的一次对话，又几乎不花 token。
 */
const AI_PROBE_TOKEN = 'SORAOK'

const trimBase = (base) => String(base).replace(/\/+$/, '')

/**
 * AI 接口：**真发起一次对话**，并检查模型按约定回了标记词
 * ---------------------------------------------------------------------------
 * 只看根路径 / `/models` 的 200 是**假成功**：地址对但 Key 错、模型名不存在，
 * 用户照样以为配好了，等真去解析资源才炸（而且那时候他早忘了自己测过）。
 * 这里发一次最小 chat（system 让它只回 `SORAOK`），**收到这个词**才算通 ——
 * 顺带验证了：出网、地址、Key、模型名、以及"这个模型会听指令"。
 * Key / 模型名从**已保存的配置**里读：密钥不从浏览器往回调，测试也不该破这个例。
 */
async function testAi(baseUrl, log) {
  const startedAt = Date.now()
  const target = `${trimBase(baseUrl)}/chat/completions`
  const { apiKey, model } = config.ai

  const deny = (reason) => {
    const ms = Date.now() - startedAt
    log.info({ target, ms, reason }, 'settings.test blocked')
    return { target, ok: false, status: 0, ms, reason }
  }
  if (!apiKey) return deny('还没填 API Key（留空 = 关闭 AI 功能）')
  if (!model) return deny('还没填模型名')

  try {
    const res = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: `你是一个连通性探针：只回复 ${AI_PROBE_TOKEN} 这个词，不要解释、不要标点。` },
          { role: 'user', content: 'ping' },
        ],
        max_tokens: 512, // 推理型模型会先"想"一段，给太少会只出思考、正文为空
        temperature: 0,
        stream: false,
      }),
      signal: AbortSignal.timeout(AI_TEST_TIMEOUT_MS),
    })
    const ms = Date.now() - startedAt
    if (!res.ok) {
      return { target, ok: false, status: res.status, ms, reason: aiReason(res.status) }
    }
    const body = await res.json().catch(() => null)
    const choice = body?.choices?.[0]
    const text = String(choice?.message?.content ?? '').trim()
    const ok = text.toUpperCase().includes(AI_PROBE_TOKEN)
    const served = body?.model || model
    log.info({ target, status: res.status, ms, ok, model: served }, 'settings.test done')
    return {
      target,
      ok,
      status: res.status,
      ms,
      reason: ok
        ? ''
        : text
          ? `模型回了「${text.slice(0, 40)}」，没回约定的 ${AI_PROBE_TOKEN}（模型名可能不对，或该模型不支持对话）`
          : choice?.finish_reason === 'length'
            ? '模型把输出额度用在了推理上、正文为空（换个非推理模型，或调大"最大输出"）'
            : '模型没有返回内容（模型名可能不对）',
      detail: ok ? `${served} 已应答` : '',
    }
  } catch (err) {
    return { target, ok: false, status: 0, ms: Date.now() - startedAt, reason: reasonOf(err) }
  }
}

/** 把 HTTP 状态翻译成使用者能懂的话（不甩状态码原文） */
function aiReason(status) {
  if (status === 401 || status === 403) return 'API Key 不对（或没有权限）'
  if (status === 404) return '接口地址或模型名不对'
  if (status === 429) return '额度用完或请求太快，稍后再试'
  return `接口返回 HTTP ${status}`
}

/**
 * 下载（qBittorrent）：**按 version 的返回判断**，不看状态码
 * ---------------------------------------------------------------------------
 * qBittorrent 对未认证的请求也会回 403/200 之类的「像样的」状态码，
 * 只看状态码会把「服务在但 Key 是错的」判成成功。这里要求**真的返回版本号**（`v5.2.1`），
 * 而且**两个版本都取**：`/app/version`（应用）+ `/app/webapiVersion`（WebAPI）。
 * 只有应用版本时，遇到"接口字段对不上"根本看不出是不是 WebAPI 版本太低；
 * 成功时两个版本一起带回去（`detail` 给界面直接显示，`versions` 给程序用）。
 */
async function testQb(baseUrl, log) {
  const startedAt = Date.now()
  const base = trimBase(baseUrl)
  const key = config.qb?.apiKey
  const target = `${base}/api/v2/app/version`

  /** 取一个纯文本端点；拿不到就回空串（不抛，免得一个失败盖掉另一个的诊断信息） */
  const readText = async (url) => {
    try {
      const res = await fetch(url, {
        headers: key ? { Authorization: `Bearer ${key}` } : {},
        signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
      })
      const text = (await res.text().catch(() => '')).trim()
      return { status: res.status, text }
    } catch (err) {
      return { status: 0, text: '', error: err }
    }
  }

  const app = await readText(target)
  const ms = Date.now() - startedAt

  const isVersion = (text) => /^v?\d+\.\d+/.test(text)
  if (isVersion(app.text)) {
    // 应用版本有了 → 顺手取 WebAPI 版本（两个都显示才算说清"连的是哪个 qB"）
    const api = await readText(`${base}/api/v2/app/webapiVersion`)
    const appVersion = app.text.split(/\s/)[0]
    const apiVersion = isVersion(api.text) ? api.text.split(/\s/)[0] : ''
    log.info({ target, status: app.status, ms, appVersion, apiVersion }, 'settings.test done')
    return {
      target,
      ok: true,
      status: app.status,
      ms: Date.now() - startedAt,
      reason: '',
      detail: apiVersion ? `${appVersion} · WebAPI ${apiVersion}` : appVersion,
      versions: { app: appVersion, api: apiVersion },
    }
  }
  if (app.error) {
    return { target, ok: false, status: 0, ms, reason: reasonOf(app.error) }
  }
  if (app.status === 401 || app.status === 403) {
    return { target, ok: false, status: app.status, ms, reason: 'API Key 不对（没通过认证）' }
  }
  if (app.status >= 500) {
    return { target, ok: false, status: app.status, ms, reason: `qBittorrent 返回 HTTP ${app.status}` }
  }
  return { target, ok: false, status: app.status, ms, reason: '这不是 qBittorrent 的接口（没返回版本号）' }
}

/** 通用 http 探针（Mikan / Bangumi 这类）：状态码 < 500 算通（401/403 说明服务活着，只是没带凭证） */
async function testHttp(target, log) {
  const startedAt = Date.now()
  try {
    const res = await fetch(target, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
      headers: { 'User-Agent': config.bgm.userAgent },
    })
    const ms = Date.now() - startedAt
    const ok = res.status < 500
    log.info({ target, status: res.status, ms, ok }, 'settings.test done')
    return { target, ok, status: res.status, ms, reason: ok ? '' : `HTTP ${res.status}` }
  } catch (err) {
    return { target, ok: false, status: 0, ms: Date.now() - startedAt, reason: reasonOf(err) }
  }
}

/** 把网络层错误翻译成使用者能懂的话（`fetch failed` 这种等于没说） */
const reasonOf = (err) => {
  if (err?.name === 'TimeoutError') return `${TEST_TIMEOUT_MS}ms 内没有响应`
  const cause = err?.cause?.code || ''
  if (cause === 'ECONNREFUSED') return '连接被拒绝（服务没启动，或地址 / 端口不对）'
  if (cause === 'ENOTFOUND' || cause === 'EAI_AGAIN') return '域名解析不了（地址写错或当前网络不通）'
  if (cause === 'ECONNRESET') return '连接被重置（可能不是 HTTP 服务，或被代理拦下）'
  if (cause === 'CERT_HAS_EXPIRED' || /certificate|self.signed/i.test(String(err?.cause?.message || ''))) {
    return '证书没通过校验'
  }
  return err?.message || '请求失败'
}

/** 单个地址的探测：判定方式按分组定（AI 真对话 / qB 真拿版本号 / 其余看状态码 < 500） */
async function probeOne(field, base, log) {
  if (field.group === 'ai') return testAi(base, log)
  if (field.group === 'qb') return testQb(base, log)
  return testHttp(base, log)
}

/**
 * 测试某个配置项的连接
 * ---------------------------------------------------------------------------
 * 为什么必须在后端测：浏览器有 CORS，前端直接 fetch 第三方域名基本都失败 ——
 * 而后端测出来的才是「真要访问它的那个进程」能不能通（顺带验证出网/代理）。
 * 「通」的标准**按服务定，不是看 200**：AI 要真发一次对话并收到约定标记、
 * 下载要真拿到版本号（见上面几个函数里的说明）；只有没有专属判定的地址才退回「状态码 < 500」。
 * **多源地址（`type: 'list'`）逐个测**：只要有一个通就算可用（多源的意义就是这样），
 * 同时把每个地址的结果都带回去，坏的那条能直接被看到。
 * @param {string} path 配置项
 * @param {string} [value] 要测的值（不传 = 测当前生效值，用户还没保存也能先试）
 */
export async function testEndpoint(path, value, { log = logger } = {}) {
  const field = SETTINGS_FIELDS.find((f) => f.path === path)
  if (!field) throw fail('NOT_FOUND', `未知配置项 ${path}`)
  if (field.type !== 'url' && field.type !== 'list') {
    throw fail('BAD_REQUEST', '只有地址类配置项能测试连接')
  }

  const raw = value === undefined || value === null || value === '' ? currentValues()[path] : value
  const checked = validateValue(field, raw)
  if (!checked.ok) throw fail('BAD_REQUEST', checked.message)

  const bases = Array.isArray(checked.value) ? checked.value : [String(checked.value)]
  const startedAt = Date.now()
  const sources = []
  for (const base of bases) sources.push({ base, ...(await probeOne(field, base, log)) })

  const ms = Date.now() - startedAt
  const usable = sources.filter((s) => s.ok)
  const first = usable[0] || sources[0]
  return {
    path,
    ok: usable.length > 0,
    status: first.status,
    ms,
    target: bases.join(' | '),
    reason: usable.length
      ? ''
      : bases.length > 1
        ? `${bases.length} 个地址都不可用：${sources.map((s) => `${s.base}（${s.reason}）`).join('；')}`
        : first.reason,
    detail: usable.length
      ? [bases.length > 1 ? `${usable.length}/${bases.length} 通过` : '', first.detail].filter(Boolean).join(' · ')
      : '',
    // 服务特有的附加信息原样带回去（qB 的 `versions`：应用版本 + WebAPI 版本）
    ...(first.versions ? { versions: first.versions } : {}),
    sources: sources.map((s) => ({ base: s.base, ok: s.ok, status: s.status, ms: s.ms, reason: s.reason })),
  }
}

/**
 * 导入：merge（默认，只覆盖文件里带的项）| replace（先清空已有覆盖再写）
 * 值不合法整包拒绝（见 lib/settings.js 的 parseImport），未知项忽略并回报。
 */
export function importSettings(payload, { mode = 'merge', log = logger } = {}) {
  const { values, ignored } = parseImport(payload)
  if (mode === 'replace') clearSettings([])
  setSettings(values)
  applyStored()

  const applied = Object.keys(values)
  log.info({ mode, applied: applied.length, ignored: ignored.length }, 'settings.import ok')
  return { mode, applied, ignored, settings: getSettings() }
}
