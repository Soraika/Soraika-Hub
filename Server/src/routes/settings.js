/**
 * 设置路由 —— 设置页的读写 + 导出/导入
 * ---------------------------------------------------------------------------
 *   GET    /api/settings              整包（分组 / 字段+当前值 / 只读项）；**密钥不回明文**
 *   PUT    /api/settings              保存 `{ values: { path: value } }`（null = 重置该项为默认）
 *   POST   /api/settings/reset        `{ paths: [] }`（空数组 = 全部重置）
 *   GET    /api/settings/export       导出 JSON 文件（默认脱敏；?secrets=1 才带密钥，界面上有警告）
 *   POST   /api/settings/test         「测试连接」：拿某个地址发一次请求（在**后端**测，浏览器有 CORS）
 *   POST   /api/settings/import       `{ payload: <导出的 JSON>, mode: 'merge'|'replace' }`
 *   GET    /api/dump/status           离线 dump 更新任务的实时状态（进度 / 上次结果 / 失败原因）
 *   POST   /api/dump/update           手动触发一次 dump 更新（`{ force }`；正在跑时返回已在跑）
 *   POST   /api/series/rebuild        重算全部系列（清 `series_checked_at`，worker 立刻接手）
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
} from './../api/pages/settings.js'
import { getDumpJobState, startDumpUpdate } from './../jobs/dump-job.js'
import { clearSeriesChecked } from './../db/anime.js'
import { getDumpState } from './../db/dump.js'
import { getWorkerState } from './../jobs/worker.js'
import { fail } from './../lib/errors.js'

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

/**
 * GET /api/dump/status —— 离线数据这一块的全部状态
 * ---------------------------------------------------------------------------
 * 一次给全，界面不用拼三个接口：
 *   · job      这一趟（或上一趟）的阶段与进度；进程重启后是 idle
 *   · stored   持久记录：上次导入的是哪一版、什么时候（`dump_state`）
 * 注意 up-to-date 不是失败：hasNew=false 时 phase 仍是 done、skipped=true。
 */
settingsRouter.get('/dump/status', (req, res, next) => {
  try {
    const stored = getDumpState()
    res.json({
      ok: true,
      data: {
        job: getDumpJobState(),
        stored: {
          name: stored?.name || '',
          size: Number(stored?.size) || 0,
          importedAt: Number(stored?.imported_at) || 0,
          checkedAt: Number(stored?.checked_at) || 0,
        },
      },
    })
  } catch (err) {
    next(err)
  }
})

/**
 * POST /api/dump/update —— 手动触发
 * ---------------------------------------------------------------------------
 * 为什么返回 200 而不是 202/409：这是「发射后不管」的任务，界面接着轮询 status。
 * 已经在跑的时候**不报错**，回 `started:false` —— 用户连点两下的正常反应，
 * 弹一个红色错误只会让人以为坏了。
 * `force:true` = 就算这一版已经导过也重灌一遍（改了导入逻辑之后要这么用）。
 */
settingsRouter.post('/dump/update', (req, res, next) => {
  try {
    const force = req.body?.force === true
    const { started, state } = startDumpUpdate({ force, trigger: 'manual', log: req.log })
    req.log?.info?.({ started, force }, 'dump.manual trigger')
    res.json({ ok: true, data: { started, job: state } })
  } catch (err) {
    next(err)
  }
})

/**
 * POST /api/series/rebuild —— 重算全部系列
 * ---------------------------------------------------------------------------
 * 什么时候需要：`series_checked_at` 是「算过就别再算」的队列谓词，所以**算错的结果会一直躺着**。
 * 典型：某一季先入库、自成一系列（series_id 指向它自己），后来前作入库时因为「首写优先」
 * 被挡在外面 → 同一部作品裂成两个系列，前端只显示人多的那个 → 用户看到「S01 是第二季」。
 * 修好合并逻辑之后，这些旧行不会自动重算（都 checked 过了），必须清一次。
 *
 * 只清 `series_checked_at`（不动 series_id / 季位）：worker 下一轮会重新走链，
 * 链是最强证据，裂片会被合并、季位整体重排。清空是安全的 —— 根名 / 命名风格只补空。
 */
settingsRouter.post('/series/rebuild', (req, res, next) => {
  try {
    const reset = clearSeriesChecked()
    const { series } = getWorkerState()
    req.log?.info?.({ reset }, 'series.rebuild queued')
    res.json({ ok: true, data: { reset, pending: series?.pending ?? null } })
  } catch (err) {
    next(err)
  }
})
