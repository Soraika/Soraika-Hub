/**
 * 设置路由 —— 设置页的读写 + 导出/导入
 * ---------------------------------------------------------------------------
 *   GET    /api/settings              整包（分组 / 字段+当前值 / 只读项）；**密钥不回明文**
 *   PUT    /api/settings              保存 `{ values: { path: value } }`（null = 重置该项为默认）
 *   POST   /api/settings/reset        `{ paths: [] }`（空数组 = 全部重置）
 *   GET    /api/settings/export       导出 JSON 文件（默认脱敏；?secrets=1 才带密钥，界面上有警告）
 *   POST   /api/settings/test         「测试连接」：拿某个地址发一次请求（在**后端**测，浏览器有 CORS）
 *   POST   /api/settings/import       `{ payload: <导出的 JSON>, mode: 'merge'|'replace' }`
 * 业务在 api/pages/settings.js，这里只做参数整形与信封。
 */
import { Router } from 'express'
import {
  exportSettings,
  getSettings,
  importSettings,
  resetSettings,
  testEndpoint,
  updateSettings,
} from '../api/pages/settings.js'
import { fail } from '../lib/errors.js'

export const settingsRouter = Router()

/** GET /api/settings */
settingsRouter.get('/settings', (req, res, next) => {
  try {
    res.json({ ok: true, data: getSettings() })
  } catch (err) {
    next(err)
  }
})

/** PUT /api/settings —— body 只认 { values: {...} } */
settingsRouter.put('/settings', (req, res, next) => {
  try {
    const values = req.body?.values
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      throw fail('BAD_REQUEST', 'body 需要是 { values: { "配置项": 值 } }')
    }
    if (!Object.keys(values).length) throw fail('BAD_REQUEST', 'values 是空的，没什么可保存')
    res.json({ ok: true, data: updateSettings(values, { log: req.log }) })
  } catch (err) {
    next(err)
  }
})

/** POST /api/settings/reset —— body `{ paths: [] }`，空 = 全部 */
settingsRouter.post('/settings/reset', (req, res, next) => {
  try {
    const paths = req.body?.paths ?? []
    if (!Array.isArray(paths)) throw fail('BAD_REQUEST', 'paths 需要是数组（空数组 = 全部重置）')
    res.json({ ok: true, data: resetSettings(paths, { log: req.log }) })
  } catch (err) {
    next(err)
  }
})

/**
 * GET /api/settings/export?secrets=1
 * 用 Content-Disposition 直接给下载：前端点一下就能存成文件（带日期的文件名，避免覆盖上一份）
 */
settingsRouter.get('/settings/export', (req, res, next) => {
  try {
    const includeSecrets = req.query.secrets === '1' || req.query.secrets === 'true'
    const payload = exportSettings({ includeSecrets })
    const stamp = payload.exportedAt.slice(0, 10)
    const name = `soraikahub-settings-${stamp}${includeSecrets ? '-with-secrets' : ''}.json`

    req.log.info({ includeSecrets, fields: Object.keys(payload.values).length }, 'settings.export ok')
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`)
    res.send(JSON.stringify(payload, null, 2))
  } catch (err) {
    next(err)
  }
})

/**
 * POST /api/settings/test —— 「测试连接」
 * body `{ path, value? }`；value 省略 = 测当前生效值（用户还没保存也能先试）
 * 注意：这是**唯一会对外发请求的 settings 接口**（见 api/pages/settings.js 里的说明：CORS 必须在后端测）
 */
settingsRouter.post('/settings/test', async (req, res, next) => {
  try {
    const { path, value } = req.body || {}
    if (!path) throw fail('BAD_REQUEST', '缺少 path（要测哪个配置项）')
    res.json({ ok: true, data: await testEndpoint(String(path), value, { log: req.log }) })
  } catch (err) {
    next(err)
  }
})

/** POST /api/settings/import —— body `{ payload, mode }` */
settingsRouter.post('/settings/import', (req, res, next) => {
  try {
    const { payload, mode } = req.body || {}
    if (!payload) throw fail('BAD_REQUEST', '缺少 payload（导出的那份 JSON）')
    if (mode !== undefined && !['merge', 'replace'].includes(mode)) {
      throw fail('BAD_REQUEST', "mode 只能是 'merge'（合并，默认）或 'replace'（清空已有的再导入）")
    }
    res.json({ ok: true, data: importSettings(payload, { mode: mode || 'merge', log: req.log }) })
  } catch (err) {
    next(err)
  }
})
