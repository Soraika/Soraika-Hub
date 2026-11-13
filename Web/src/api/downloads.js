/**
 * 下载接口（qBittorrent）
 * ---------------------------------------------------------------------------
 * 后端是 qB 的代理 + 归一：前端不直接连 qB（浏览器跨域 + 不该拿到 qB 的 Key）。
 * 形状见 Server/src/api/pages/downloads.js。
 */
import { apiGet, apiPost } from './http'

/**
 * 下载页卡片墙
 * @param {{ fresh?: boolean }} [options] fresh = 用户点了「刷新」（后端跳过 4 秒缓存）
 * @returns {Promise<{
 *   configured: boolean,
 *   versions: { app: string, api: string } | null,
 *   transfer: { status: string, dlSpeed: number, upSpeed: number } | null,
 *   counts: { total:number, downloading:number, done:number, missing:number, anime:number,
 *             sizeBytes:number, sizeText:string },
 *   items: Array<{ animeId:number, title:string, poster:string, count:number, doneCount:number,
 *     downloadingCount:number, missingCount:number, latestEpisode:number, totalEpisodes:number,
 *     seasons:number[], season:number, sizeText:string, state:'downloading'|'done'|'missing',
 *     stateText:string, progress:number, speedText:string }>,
 *   unmatched: Array<{ name:string, count:number, sizeText:string, stateText:string }>
 * }>}
 */
export function fetchDownloads({ fresh = false } = {}) {
  // qB 结巴的时候一次种子列表要好几秒，给足超时（但比默认 15 秒长，避免误判失败）
  return apiGet('/api/downloads', { params: fresh ? { fresh: 1 } : {}, timeout: 30000 })
}

/**
 * 某部作品已下载的资源（面板「资源」区；按字幕组分组）
 * @param {number|string} animeId 作品主键
 * @returns {Promise<{ animeId:number, title:string, total:number, sizeText:string,
 *   subgroups: Array<{ id:string, name:string, count:number, items: Array<{
 *     hash:string, name:string, fileName:string, episode:string, season:number,
 *     state:string, stateText:string, kind:string, progress:number, sizeText:string,
 *     savePath:string, contentPath:string, addedAt:number }> }> }>}
 */
export function fetchAnimeDownloads(animeId) {
  return apiGet(`/api/downloads/${encodeURIComponent(animeId)}`, { timeout: 30000 })
}

/**
 * 勾选资源 → 加种
 * @param {{ animeId:number, subgroup?:string, season?:number,
 *           items: Array<{ title:string, magnet?:string, torrentUrl?:string, episode?:string }> }} payload
 * @returns {Promise<{ savePath:string, tags:string,
 *   added: Array<{title:string, episode:string}>, failed: Array<{title:string, reason:string}> }>}
 */
export function addDownloads(payload) {
  return apiPost('/api/downloads', payload, { timeout: 60000 })
}

/**
 * 重命名（**任务名和实际文件名是两件事**，可以分开改）
 * ---------------------------------------------------------------------------
 * 默认 dryRun：只返回「会改成什么」（plan / skipped），不写 qB；
 * 确认后传 `dryRun:false` 才真改（qB 的 rename 不影响做种与数据）。
 * `scope`：'all'（默认，两个都改）/ 'torrentName'（只改 qB 列表里那个名字）/
 *          'fileName'（只改种子内的文件）。
 * @param {number} animeId 作品主键
 * @param {{ dryRun?: boolean, scope?: 'all'|'torrentName'|'fileName' }} [options]
 * @returns {Promise<{ dryRun:boolean, scope:string, title:string,
 *   plan: Array<{ hash:string, episode:string, oldName:string, newName:string,
 *     renameTorrent:boolean, renameFiles:number, filePlan:Array<{from:string,to:string,ok:boolean}>,
 *     summary:string }>,
 *   skipped: Array<{ hash:string, name:string, reason:string }>,
 *   done?: Array<object>, failed?: Array<object> }>}
 */
export function renameDownloads(animeId, { dryRun = true, scope = 'all' } = {}) {
  return apiPost('/api/downloads/rename', { animeId, dryRun, scope }, { timeout: 120000 })
}

/**
 * 单个种子的两种名字（弹窗用）
 * @param {string} hash 种子 hash
 * @returns {Promise<{ hash:string, animeId:number|null, animeTitle:string, episode:string,
 *   state:string, stateText:string, torrentName:string,
 *   files: Array<{ name:string, size:number }>,
 *   suggest: { torrentName:{from:string,to:string,ok:boolean,reason:string},
 *              files: Array<{ from:string,to:string,ok:boolean,kind:string,reason:string }> },
 *   summary: string }>}
 */
export function fetchTorrentNaming(hash) {
  return apiGet(`/api/downloads/torrent/${encodeURIComponent(hash)}`, { timeout: 30000 })
}

/**
 * 单个种子改名 —— 两个名字互不影响
 * @param {string} hash
 * @param {{ torrentName?: string, files?: Array<{ oldPath:string, newPath:string }>, dryRun?: boolean }} payload
 * @returns {Promise<{ dryRun:boolean, done:Array<object>, failed:Array<object> }>}
 */
export function renameTorrent(hash, payload) {
  return apiPost(`/api/downloads/torrent/${encodeURIComponent(hash)}/rename`, payload, { timeout: 60000 })
}

/**
 * qB 状态（设置页显示版本用；没配时返回 `{ configured:false }`）
 * @returns {Promise<{ configured:boolean, versions?:{app:string,api:string}, transfer?:object }>}
 */
export function fetchQbStatus() {
  return apiGet('/api/qb/status', { timeout: 15000 })
}
