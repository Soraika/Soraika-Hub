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
 * 重命名（qB 任务名 + 落盘文件名）
 * ---------------------------------------------------------------------------
 * 默认 dryRun：只返回「会改成什么」（plan / skipped），不写 qB；
 * 确认后传 `dryRun:false` 才真改（qB 的 rename 不影响做种与数据）。
 * @param {number} animeId 作品主键
 * @param {{ dryRun?: boolean }} [options]
 * @returns {Promise<{ dryRun:boolean, title:string,
 *   plan: Array<{ hash:string, oldName:string, newName:string, oldFileName:string, newFileName:string }>,
 *   skipped: Array<{ name:string, reason:string }>,
 *   done?: Array<object>, failed?: Array<object> }>}
 */
export function renameDownloads(animeId, { dryRun = true } = {}) {
  return apiPost('/api/downloads/rename', { animeId, dryRun }, { timeout: 120000 })
}

/**
 * qB 状态（设置页显示版本用；没配时返回 `{ configured:false }`）
 * @returns {Promise<{ configured:boolean, versions?:{app:string,api:string}, transfer?:object }>}
 */
export function fetchQbStatus() {
  return apiGet('/api/qb/status', { timeout: 15000 })
}
