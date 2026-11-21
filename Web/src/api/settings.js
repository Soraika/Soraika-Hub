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
