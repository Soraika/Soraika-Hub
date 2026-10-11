/**
 * 作品详情接口
 * ---------------------------------------------------------------------------
 * 侧边详情面板点开时调一次。后端是纯读库（不碰上游），所以超时给得比首页短。
 * 接口形状见 Server/src/api/pages/anime.js。
 */
import { apiGet } from './http'

/**
 * 按作品主键取详情
 * @param {number|string} id 卡片上的 item.id（作品主键，不是 mikanId / bgmId）
 * @returns {Promise<{ id:number, title:string, titleOriginal:string, poster:string,
 *   score:number|null, ratingText:string, watchingText:string, epsText:string,
 *   seasonText:string, weekdayText:string, airDate:string, tags:string[], summary:string,
 *   bgmId:string|null, mikanId:string|null, bgmUrl:string, mikanUrl:string }>}
 */
export function fetchAnimeDetail(id) {
  return apiGet(`/api/anime/${encodeURIComponent(id)}`, { timeout: 10000 })
}

/**
 * 作品下的字幕组列表（面板「资源」区第一级）
 * 库里没有时后端会现场补一次 Mikan 详情页，所以给它宽一点超时
 * @param {number|string} id 作品主键
 * @returns {Promise<{ items: Array<{id:number,name:string,mikanId:string,rssId:string}>, source: 'db'|'mikan' }>}
 */
export function fetchAnimeSubgroups(id) {
  return apiGet(`/api/anime/${encodeURIComponent(id)}/subgroups`, { timeout: 20000 })
}

/**
 * 某字幕组的资源列表（第二级）
 * @param {number|string} id 作品主键
 * @param {number} subgroupId 字幕组主键（上面接口返回的 id）
 * @returns {Promise<{ subgroup: {id:number,name:string}, items: Array<{
 *   title:string, magnet:string|null, magnetHash:string|null, torrentUrl:string|null,
 *   sizeText:string, publishedText:string }>, total:number, cached:boolean }>}
 */
export function fetchSubgroupReleases(id, subgroupId) {
  return apiGet(`/api/anime/${encodeURIComponent(id)}/releases`, {
    params: { subgroupId },
    timeout: 20000,
  })
}
