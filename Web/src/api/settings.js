/**
 * 设置接口
 * ---------------------------------------------------------------------------
 * 后端形状见 Server/src/routes/settings.js：
 *   · GET  /api/settings        整包（分组 / 字段+当前值 / 只读项）；**密钥只回「配没配」，不回明文**
 *   · PUT  /api/settings        保存 `{ values: { path: value } }`；某项传 null = 还原该项为默认
 *   · POST /api/settings/reset  重置（paths 空数组 = 全部）
 *   · 导出走浏览器直接下载（后端给 Content-Disposition），所以这里只提供 URL
 *   · GET  /api/dump/status     离线 dump 更新任务状态（进度 / 上次结果）
 *   · POST /api/dump/update     手动触发一次更新（发射后不管，之后轮询 status）
 */
import { apiGet, apiPost, apiPut } from './http'

/** @returns {Promise<{ groups:Array, fields:Array, readonly:Array, overridden:string[], updatedAt:number|null }>} */
export const fetchSettings = () => apiGet('/api/settings', { timeout: 10000 })

/** 保存（只传改过的项） */
export const saveSettings = (values) => apiPut('/api/settings', { values }, { timeout: 20000 })

/** 重置：paths 为空数组 = 全部还原为代码默认值 */
export const resetSettings = (paths = []) => apiPost('/api/settings/reset', { paths }, { timeout: 20000 })

/** 导入（payload 就是导出的那份 JSON；mode: merge | replace） */
export const importSettings = (payload, mode = 'merge') =>
  apiPost('/api/settings/import', { payload, mode }, { timeout: 30000 })

/** 导出下载地址：`secrets=1` 会把密钥一起导出（界面上有警告） */
export const exportUrl = (includeSecrets = false) => `/api/settings/export${includeSecrets ? '?secrets=1' : ''}`

/**
 * 测试连接（设置页每行右边那个插头按钮）
 * 必须走后端：浏览器 fetch 第三方域名会被 CORS 挡掉，测不出真结果
 * @param {string} path 配置项
 * @param {string} [value] 要测的值（不传 = 测已保存的生效值）
 * @returns {Promise<{ path:string, target:string, ok:boolean, status:number, ms:number, reason:string }>}
 */
export const testSetting = (path, value) => apiPost('/api/settings/test', { path, value }, { timeout: 15000 })

/* ── 离线 dump（Bangumi 全站数据）────────────────────────────────────────────
 * 手动更新是**长任务**（下载 450MB + 导入），所以接口只负责「起一个任务」，
 * 进度靠轮询状态拿 —— 不做 SSE/WebSocket，一个按钮不值得那套。
 */

/**
 * 更新任务状态
 * @returns {Promise<{ job:{ phase:string, running:boolean, progress:{bytes:number,total:number,percent:number},
 *   result:object|null, lastError:string|null, skipped:boolean, latestName:string },
 *   stored:{ name:string, size:number, importedAt:number, checkedAt:number } }>}
 */
export const fetchDumpStatus = () => apiGet('/api/dump/status', { timeout: 10000 })

/**
 * 手动触发更新
 * @param {boolean} [force] true = 这一版导过也重灌（改了导入逻辑之后用）
 * @returns {Promise<{ started:boolean, job:object }>} 已在跑时 started=false（不是错误）
 */
export const startDumpUpdate = (force = false) => apiPost('/api/dump/update', { force }, { timeout: 15000 })

/**
 * 重算全部系列（清 `series_checked_at`，后台 worker 立刻接手）
 * ---------------------------------------------------------------------------
 * 为什么需要这个按钮：系列是「算过就不重算」的，所以**算错的结果会一直留着**。
 * 典型症状：点开某一部，系列里少了第一季（S01 变成第二季）。用这个重跑一遍，
 * 走链会按上游关系把裂开的几季合并、季位重排。
 * @returns {Promise<{ reset:number, pending:number|null }>} reset = 被清空重算的行数
 */
export const rebuildSeries = () => apiPost('/api/series/rebuild', {}, { timeout: 30000 })

/**
 * 映射扫描状态（补齐 mikan→bgm 身份 + 档案）
 * @returns {Promise<{ job:{phase:string,running:boolean,total:number,done:number,
 *   resolved:number,noLink:number,failed:number,imported:object,mapCount:number,stillMissing:number},
 *   counts:{ map:number, missingBgm:number } }>}
 */
export const fetchMapStatus = () => apiGet('/api/map/status', { timeout: 10000 })

/**
 * 手动触发映射扫描（发射后不管，之后轮询 status）
 * @param {{ limit?: number }} [options] limit=0 表示扫到没有为止
 */
export const startMapScan = (options = {}) => apiPost('/api/map/scan', options, { timeout: 20000 })

/**
 * 向前扫描一段（水位推进）—— 「往后多少位是空就算没有更新了」
 * 水位存在库里（`mikan_scan.watermark`），所以这个动作可以每天点一次，也可以交给每日任务。
 * @param {number} [span] 本次扫多少个 id（默认 300，服务端夹在 20~3000）
 */
export const sweepMapIds = (span = 300) => apiPost('/api/map/sweep', { span }, { timeout: 30000 })

/**
 * 季度枚举 —— 用排期页一次性把 mikan_id 找齐（最快的一条路）
 * 56 页 ≈ 1 分钟，拿到全站该有的 mikan_id，顺带把历史季度的排期写进库。
 * @param {{ fromYear?: number, toYear?: number }} [range]
 */
export const enumerateSeasons = (range = {}) => apiPost('/api/map/enumerate', range, { timeout: 30000 })

/** 叫停（正在处理的那一条会跑完） */
export const stopMapScan = () => apiPost('/api/map/scan', { stop: true }, { timeout: 10000 })

/* ── MCP 服务（把动画库与下载控制交给 agent）──────────────────────────────────
 * 开关本身是设置项（group=mcp，保存后重启生效），这里只管「拿到手就能用」：
 *   · GET  /api/mcp/status  端点 / 令牌（SK 样式）/ 工具清单 / 调用统计 / 三份客户端片段
 *   · POST /api/mcp/token   重新生成令牌（旧的立刻失效，破坏性操作，界面上要二次确认）
 *   · POST /api/mcp/ping    自检：后端用自己的 HTTP 打一次 /mcp 的 initialize
 * 自检必须走后端 —— 浏览器直连 /mcp 会被 CORS 挡掉，测不出真结果。
 */

/**
 * @returns {Promise<{ enabled:boolean, allowWrite:boolean, endpoint:string, token:string,
 *   tools:Array<{name:string,title:string,description:string,write:boolean}>,
 *   stats:{calls:number,toolCalls:number,lastCallAt:number|null},
 *   clients:Array<{name:string,kind:'shell'|'json'|'yaml',snippet:string}> }>}
 */
export const fetchMcpStatus = () => apiGet('/api/mcp/status', { timeout: 10000 })

/** 重新生成令牌（返回新令牌明文 —— 界面要立刻显示出来，否则人就拿不到了） */
export const regenerateMcpToken = () => apiPost('/api/mcp/token', {}, { timeout: 15000 })

/** 自检：`data.ok=false` 时 `data.error` 是中文原因（不是异常，别当请求失败） */
export const pingMcp = () => apiPost('/api/mcp/ping', {}, { timeout: 20000 })
