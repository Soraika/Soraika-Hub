/**
 * AI 接口
 * ---------------------------------------------------------------------------
 * 后端形状见 Server/src/routes/ai.js / Server/docs/MCP.md。
 * 要点：没配 key 不是错误。后端会回 AI_DISABLED（501），
 * 前端按 code 显示「未配置」，而不是弹「失败，请重试」（重试一万次也不会好）。
 */
import { apiGet, apiPost, apiPut } from './http'

/**
 * AI 能力清单（含是否已配置）
 * @returns {Promise<{ enabled:boolean, model:string, concurrency:number,
 *   tools:Array<{name:string,description:string,inputSchema:object}> }>}
 */
export function fetchAiTools() {
  return apiGet('/api/ai/tools', { timeout: 8000 })
}

/** 读取 AI 模型列表（设置页「模型」下拉用；传地址 = 按**还没保存**的地址取）
 *  未配置或取不到都回落成手动输入（不打扰填写） */
export const fetchAiModels = (baseUrl = '') =>
  apiGet('/api/ai/models', { params: baseUrl ? { baseUrl } : {}, timeout: 15000 })

/** 读取 AI 供应商目录（社区维护的 models.dev；后端取不到会退回内置清单） */
export const fetchAiProviders = () => apiGet('/api/ai/providers', { timeout: 20000 })

/**
 * 资源文件名 → 筛选标签
 * 带作品上下文；全量分析：后端按单批上限切批、批间并发跑完，结果按内容哈希缓存。
 * @param {string[]} titles 资源文件名
 * @param {{ animeTitle?: string, season?: string|number }} [context]
 * @returns {Promise<{ tags:Array<{name:string,type:string,all:boolean,match:string[]}>,
 *                     model:string, cached:boolean, ms:number, analyzed:number }>}
 */
export function classifyReleaseTags(titles, { animeTitle = '', season = '' } = {}) {
  return apiPost('/api/ai/classify/tags', { titles, animeTitle, season }, { timeout: 120000 })
}

/**
 * 资源文件名 → 每条资源的集数
 * 集数由 AI 逐条解析（前端本地规则只做兜底）：文件名写法补不完，
 * 而 AI 对 `- 1180 (B-Global …)`、`S01E12`、`第1180集` 这类一律认得。
 * 番名与季不在返回里：番名就是传进去的 animeTitle，季由系列的季位决定。
 * @param {string} animeTitle 作品标题（帮模型认清这批资源属于谁）
 * @param {string[]} titles 资源文件名
 * @returns {Promise<{ episodes:Record<string, number|string|null>,
 *                     model:string, batches:number, cached:boolean, ms:number }>}
 */
export function classifyEpisodes(animeTitle, titles, { season = '' } = {}) {
  return apiPost('/api/ai/classify/episodes', { title: animeTitle, titles, season }, { timeout: 180000 })
}

/**
 * 读当前生效的提示词（五段：bundle 标签+集数 / series 系列 / format 格式 / groupTags 组标记 / search 搜索意图）
 * 同时给出出厂默认（customized 之外的「恢复默认」要用它）与来源（default / override）。
 * @returns {Promise<{ source:string, keys:string[], customized:string[],
 *   prompts:Record<string,{version:string,hash:string,system:string}>,
 *   defaults:Record<string,string> }>}
 */
export function fetchAiPrompts() {
  return apiGet('/api/ai/prompts', { timeout: 10000 })
}

/**
 * 保存提示词（写 data/prompts.json，立即生效，不用重启）
 * @param {Record<string, { system:string }>} prompts 只传要改的段；数组为空等于什么都不改
 */
export function saveAiPrompts(prompts) {
  return apiPut('/api/ai/prompts', { prompts }, { timeout: 15000 })
}

/** 整份恢复出厂默认（删掉覆盖文件） */
export function resetAiPrompts() {
  return apiPut('/api/ai/prompts', { prompts: null }, { timeout: 15000 })
}
