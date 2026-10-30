/**
 * AI 接口
 * ---------------------------------------------------------------------------
 * 后端形状见 Server/src/rout/ai.js / Server/docs/MCP.md。
 * 要点：**没配 key 不是错误** —— 后端会回 AI_DISABLED（501），
 * 前端按 code 显示「未配置」，而不是弹「失败，请重试」（重试一万次也不会好）。
 */
import { apiGet, apiPost } from './http'

/**
 * AI 能力清单（含是否已配置）
 * @returns {Promise<{ enabled:boolean, model:string, maxTitles:number,
 *   tools:Array<{name:string,description:string,inputSchema:object}> }>}
 */
export function fetchAiTools() {
  return apiGet('/api/ai/tools', { timeout: 8000 })
}

/** 读取 AI 模型列表（设置页「模型」下拉用；传地址 = 按**还没保存**的地址取）
 *  未配置或取不到都回落成手动输入（不打扰填写） */
export const fetchAiModels = (baseUrl = '') =>
  apiGet('/api/ai/models', { params: baseUrl ? { baseUrl } : {}, timeout: 15000 })

/**
 * 资源文件名 → 筛选标签
 * @param {string[]} titles 资源文件名列表
 * @returns {Promise<{ tags:Array<{name:string,type:string,match:string[]}>, info:string[],
 *                     model:string, cached:boolean, ms:number }>}
 */
/**
 * 资源文件名 → 筛选标签（带作品上下文；**全量**分析：后端按 `ai.maxTitles` 单批上限切批、并发跑完）
 * @param {string[]} titles 资源文件名
 * @param {{ animeTitle?: string, season?: string|number }} [context]
 * @returns {Promise<{ tags:Array<{name:string,type:string,all:boolean,match:string[]}>,
 *                     model:string, cached:boolean, ms:number, analyzed:number }>}
 */
export function classifyReleaseTags(titles, { animeTitle = '', season = '' } = {}) {
  return apiPost('/api/ai/classify/tags', { titles, animeTitle, season }, { timeout: 120000 })
}

/**
 * 资源文件名 → 集数 / 季 / 纯番名
 * 集数**由 AI 逐条解析**（前端本地规则只做兜底）：文件名写法补不完，
 * 而 AI 对 `- 1180 (B-Global …)`、`S01E12`、`第1180集` 这类一律认得。
 * @param {string} animeTitle 作品标题（帮模型认清季数）
 * @param {string[]} titles 资源文件名
 * @returns {Promise<{ rawName:string, season:number, episodes:Record<string, number|string|null>,
 *                     model:string, batches:number, cached:boolean, ms:number }>}
 */
export function classifyEpisodes(animeTitle, titles) {
  return apiPost('/api/ai/classify/episodes', { title: animeTitle, titles }, { timeout: 180000 })
}
