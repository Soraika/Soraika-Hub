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
import { getQbGlobalTransferInfo, getQbTorrentList, getQbVersion, postQbAddTorrent } from '../../clients/Qb.js'
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

/**
 * 加种
 * @param {{ url: string, savePath: string, tags: string, category?: string, paused?: boolean }} params
 * @returns {Promise<{ ok: boolean, raw: string }>}
 */
export async function qbAddTorrent({ url, savePath, tags = '', category, paused = false }) {
  ensureConfigured()
  if (!url) throw fail('BAD_REQUEST', '缺少下载地址（磁力或种子链接）')

  const raw = await postQbAddTorrent(
    config.qb.base,
    config.qb.apiKey,
    {
      urls: url,
      savepath: savePath,
      ...(category ? { category } : {}),
      ...(tags ? { tags } : {}),
      ...(paused ? { paused: 'true' } : {}),
    },
    0,
  )
  // qB 的成功应答是纯文本 Ok.；失败是 Fails.
  const text = String(raw ?? '').trim()
  logger.info({ savePath, category, ok: /^ok/i.test(text), raw: text.slice(0, 40) }, 'qb.add done')
  if (!/^ok/i.test(text)) throw fail('UPSTREAM', `qBittorrent 拒绝了这次加种（${text || '没有应答'}）`)
  torrentCache.at = 0 // 新种子立刻要能看到 → 让缓存失效
  return { ok: true, raw: text }
}
