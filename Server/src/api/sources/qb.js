/**
 * qBittorrent 数据源适配 —— 版本 / 传输 / 种子列表 / 加种
 * ---------------------------------------------------------------------------
 * `clients/Qb.js` 是最底层的请求封装（含重试与日志），这里做三件事：
 *   ① **缓存**：下载页一进去就要一份种子列表（176 条 / 一次 100KB+），
 *      几秒内的重复请求不该反复打 qB（qB 自己被频繁查询也会卡）
 *   ② **归一**：把 qB 的字段翻译成界面直接能用的形状（速度、状态、进度）
 *   ③ **说人话的失败**：底层失败返回 null，这里抛带 code 的错误（路由层转成信封）
 *
 * 认证方式：qB 的 WebAPI 官方是「先 /auth/login 拿 cookie」，但这套部署前面挂了
 * 一层把 `Authorization: Bearer <key>` 认成登录态的网关（key 由用户在设置页填），
 * 所以这里沿用 `clients/Qb.js` 的 Bearer 写法 —— 两处保持一致，别一边改一边忘。
 */
import { config } from '../../config.js'
import { fetchQbPost, getQbGlobalTransferInfo, getQbTorrentList, getQbVersion } from '../../clients/Qb.js'
import { fail } from '../../lib/errors.js'
import { logger } from '../../lib/logger.js'

/** 版本号不会变，缓存久一点；传输/种子列表是「实时」的，缓存只用来挡连击 */
const VERSION_TTL_MS = 60_000
const TORRENT_TTL_MS = 4_000

const NOT_CONFIGURED = '还没配置 qBittorrent 的地址与 API Key（设置 → 下载）'
const UNREACHABLE = '连不上 qBittorrent（地址 / Key 不对，或服务没启动）'

const versionCache = { at: 0, value: null }
const torrentCache = { at: 0, value: null }

/** 配置齐了没有（缺一个就什么都做不了） */
export const qbConfigured = () => Boolean(config.qb?.base && config.qb?.apiKey)

/** 底层调用统一入口：没配 → NOT_CONFIGURED；调用失败（null）→ UPSTREAM */
function ensureConfigured() {
  if (!qbConfigured()) throw fail('BAD_REQUEST', NOT_CONFIGURED)
}

/**
 * 应用版本 + WebAPI 版本
 * ---------------------------------------------------------------------------
 * **两个版本都要**：界面上写 `v5.2.1 · WebAPI 2.15.1` 才说得清「连的是哪个 qB」——
 * 只有 APP 版本时，遇到「接口字段对不上」根本看不出是 WebAPI 版本太低。
 * @returns {Promise<{ app: string, api: string }>}
 */
export async function qbVersions({ fresh = false } = {}) {
  ensureConfigured()
  if (!fresh && versionCache.value && Date.now() - versionCache.at < VERSION_TTL_MS) return versionCache.value

  const res = await getQbVersion(config.qb.base, config.qb.apiKey, 0)
  if (!res?.applicationVersion) throw fail('UPSTREAM', UNREACHABLE)
  const value = { app: String(res.applicationVersion), api: String(res.apiVersion || '') }
  versionCache.at = Date.now()
  versionCache.value = value
  return value
}

/** 全局传输状态（下载页顶部的速度用）；拿不到就当 0，不挡页面 */
export async function qbTransfer() {
  ensureConfigured()
  const info = await getQbGlobalTransferInfo(config.qb.base, config.qb.apiKey, 0)
  return {
    status: info?.connection_status || 'unknown',
    dlSpeed: Number(info?.dl_info_speed) || 0,
    upSpeed: Number(info?.up_info_speed) || 0,
  }
}

/**
 * 种子列表（原始字段，归一在 api/pages/downloads.js 里做）
 * @param {{ fresh?: boolean }} [options] fresh=true 跳过缓存（用户点「刷新」）
 * @returns {Promise<Array<object>>}
 */
export async function qbTorrents({ fresh = false } = {}) {
  ensureConfigured()
  if (!fresh && torrentCache.value && Date.now() - torrentCache.at < TORRENT_TTL_MS) return torrentCache.value

  const list = await getQbTorrentList(config.qb.base, config.qb.apiKey, {}, 0)
  if (!Array.isArray(list)) throw fail('UPSTREAM', UNREACHABLE)
  torrentCache.at = Date.now()
  torrentCache.value = list
  return list
}

/** qB 加种接口的路径（写死一次，避免调用处再传错参数顺序） */
const ADD_PATH = '/api/v2/torrents/add'

/**
 * qB 加种应答 → 结论（纯函数，验收直接喂数据）
 * ---------------------------------------------------------------------------
 * qB 5.x 的三种真实应答，实测出来的：
 *   · 成功 → 200 + 纯文本 `Ok.`
 *   · **重复种子 → HTTP 409**（不是 `Fails.`）——「已经在列表里」不是失败，
 *     用户点两次/批量里勾了同一个种子都会走到这里
 *   · 其它拒绝 → `Fails.` 或错误体
 * @param {{ status?: number, text?: string }} params
 * @returns {{ ok: boolean, existed: boolean, reason: string }}
 */
export function classifyAddResult({ status = 0, text = '' } = {}) {
  // 对象/空值一律收敛成可读文本 —— 直接模板拼接会得到 [object Object]
  const body = typeof text === 'string' ? text.trim() : text == null ? '' : JSON.stringify(text).slice(0, 120)
  if (/^ok/i.test(body)) return { ok: true, existed: false, reason: '' }
  if (Number(status) === 409) return { ok: true, existed: true, reason: '种子已经在下载列表里' }

  /* qB 5.2 起 /torrents/add 会回一段 JSON（实测）：
     {"added_torrent_ids":["…"],"failure_count":0,"pending_count":0,"success_count":1}
     success_count > 0 就是加进去了；failure_count > 0 且没有成功 id 才是失败。 */
  if (body.startsWith('{')) {
    try {
      const payload = JSON.parse(body)
      const success = Number(payload?.success_count) || 0
      const failure = Number(payload?.failure_count) || 0
      const ids = Array.isArray(payload?.added_torrent_ids) ? payload.added_torrent_ids : []
      if (success > 0 || (failure === 0 && ids.length > 0)) return { ok: true, existed: false, reason: '' }
      if (failure > 0) {
        return { ok: false, existed: false, reason: `qBittorrent 拒绝了这次加种（失败 ${failure} 条）` }
      }
    } catch {
      /* 不是合法 JSON → 落到下面的通用文案 */
    }
  }

  if (/^fails?\.?$/i.test(body)) return { ok: false, existed: false, reason: 'qBittorrent 拒绝了这次加种（Fails.）' }
  const hint = body ? body.slice(0, 120) : Number(status) ? `HTTP ${status}` : '没有应答'
  return { ok: false, existed: false, reason: `qBittorrent 拒绝了这次加种（${hint}）` }
}

/** 磁力里的 btih（用于「说失败但其实加进去了」的复核） */
const torrentHashOf = (url) => /urn:btih:([0-9a-z]{32,40})/i.exec(String(url || ''))?.[1]?.toLowerCase() || ''

/**
 * 加种
 * @param {{ url: string, savePath: string, tags: string, category?: string, paused?: boolean }} params
 * @returns {Promise<{ ok: boolean, existed: boolean, raw: string }>} existed = 本来就在列表里
 */
export async function qbAddTorrent({ url, savePath, tags = '', category, paused = false }) {
  ensureConfigured()
  if (!url) throw fail('BAD_REQUEST', '缺少下载地址（磁力或种子链接）')

  let status = 0
  let text = ''
  try {
    text = await fetchQbPost(
      config.qb.base,
      ADD_PATH,
      {
        urls: url,
        savepath: savePath,
        ...(category ? { category } : {}),
        ...(tags ? { tags } : {}),
        ...(paused ? { paused: 'true' } : {}),
      },
      config.qb.apiKey,
      'QbAddTorrent',
      1,
    )
    status = 200
  } catch (err) {
    // 4xx 会立刻抛（不重试），把状态码与响应体带出来判断；网络错误仍然算失败
    status = Number(err?.status) || 0
    text = String(err?.bodyText || '')
  }

  let verdict = classifyAddResult({ status, text })

  /* 兜底复核：「说失败但其实已经在列表里」—— 用磁力 hash 查一次（torrent 文件没有 hash 就跳过） */
  if (!verdict.ok && !verdict.existed) {
    const hash = torrentHashOf(url)
    if (hash) {
      try {
        const list = await getQbTorrentList(config.qb.base, config.qb.apiKey, { hashes: hash }, 0)
        if (Array.isArray(list) && list.some((t) => String(t.hash || '').toLowerCase() === hash)) {
          verdict = { ok: true, existed: true, reason: '种子已经在下载列表里' }
        }
      } catch {
        /* 复核失败不改变结论，按原错误报 */
      }
    }
  }

  logger.info(
    { savePath, category, ok: verdict.ok, existed: verdict.existed, status, raw: String(text).slice(0, 40) },
    'qb.add done',
  )
  if (!verdict.ok) throw fail('UPSTREAM', verdict.reason)
  torrentCache.at = 0 // 新种子立刻要能看到 → 让缓存失效
  return { ok: true, existed: verdict.existed, raw: String(text ?? '') }
}

/** qB 改名接口的路径（同样写死，避免参数顺序出错） */
const RENAME_PATH = '/api/v2/torrents/rename'
const RENAME_FILE_PATH = '/api/v2/torrents/renameFile'

/**
 * 改名类操作共用：拿状态码 + 响应体 → 可读结论
 * （qB 5.2 的成功应答是 `Ok.`，个别版本会回 JSON；409 = 目标名字已被占用）
 */
async function callQbAction(path, params, tip) {
  let status = 0
  let text = ''
  try {
    text = await fetchQbPost(config.qb.base, path, params, config.qb.apiKey, tip, 1)
    status = 200
  } catch (err) {
    status = Number(err?.status) || 0
    text = String(err?.bodyText || '')
  }
  /* 实测：rename / renameFile 成功时是 **200 + 空 body**（不是 `Ok.`），
     所以先按状态码判成功；失败时 qB 会带一句人话（如「文件已存在：…」）。 */
  if (status >= 200 && status < 300 && !text.trim()) {
    torrentCache.at = 0
    return { ok: true }
  }
  if (status === 409) {
    return { ok: false, status, reason: text.trim() ? `qB：${text.trim()}` : '目标名字已被占用（qB 回 409）' }
  }
  const verdict = classifyAddResult({ status, text })
  if (!verdict.ok) {
    return { ok: false, status, reason: verdict.reason.replace('这次加种', '这次重命名').replace('这次操作', '这次重命名') }
  }
  torrentCache.at = 0 // 名字变了 → 列表缓存作废
  return { ok: true }
}

/**
 * 重命名种子（qB 里显示的任务名）
 * @param {{ hash: string, name: string }} params
 */
export async function qbRenameTorrent({ hash, name } = {}) {
  ensureConfigured()
  if (!hash) throw fail('BAD_REQUEST', '缺少种子 hash')
  if (!name) throw fail('BAD_REQUEST', '缺少新任务名')
  const res = await callQbAction(RENAME_PATH, { hash, name }, 'QbRenameTorrent')
  if (!res.ok) throw fail('UPSTREAM', res.reason)
  return { ok: true }
}

/**
 * 重命名种子内的文件（实际落盘名）；不影响做种与数据
 * @param {{ hash: string, oldPath: string, newPath: string }} params
 */
export async function qbRenameFile({ hash, oldPath, newPath } = {}) {
  ensureConfigured()
  if (!hash) throw fail('BAD_REQUEST', '缺少种子 hash')
  if (!oldPath || !newPath) throw fail('BAD_REQUEST', '缺少文件路径（oldPath / newPath）')
  const res = await callQbAction(RENAME_FILE_PATH, { hash, oldPath, newPath }, 'QbRenameFile')
  if (res.ok) return { ok: true }

  /* 幂等：目标名字已经在了（上一次改成功、或文件名本来就是它）→ 不算失败。
     判据是 qB 现在报的 content_path 文件名 === newPath（不是猜）。 */
  try {
    const list = await getQbTorrentList(config.qb.base, config.qb.apiKey, { hashes: hash }, 0)
    const current = String(list?.[0]?.content_path || '').split('/').pop()
    if (current && current === newPath) {
      torrentCache.at = 0
      return { ok: true, existed: true }
    }
  } catch {
    /* 查不到就按原错误报 */
  }
  throw fail('UPSTREAM', res.reason)
}
