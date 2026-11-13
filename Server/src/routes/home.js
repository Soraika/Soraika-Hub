/**
 * 首页路由 —— 只做「校验参数 + 调聚合层 + 返回信封」，业务逻辑不写在这里
 * （这样以后 MCP「把已有接口公开」可以直接复用 api/ 层，不用再抄一遍）
 */
import { Router } from 'express'
import { getHomeSchedule } from './../api/pages/home.js'
import { fail } from './../lib/errors.js'
import { SEASONS } from './../domain/season.js'

export const homeRouter = Router()

/**
 * GET /api/home/schedule?year=2026&season=夏&force=1
 * year / season 都可选：不给就用「当前季」（后端按服务器时区算 —— 前端注释里提到的时区问题在这解决）
 * force=1 跳过缓存，强制回源刷新
 */
homeRouter.get('/home/schedule', async (req, res, next) => {
  try {
    const { year, season, force } = req.query

    if (year !== undefined && !/^\d{4}$/.test(String(year))) {
      throw fail('BAD_REQUEST', 'year 需要是 4 位年份，例如 2026')
    }
    if (season !== undefined && !SEASONS.includes(String(season))) {
      throw fail('BAD_REQUEST', `season 只能是 ${SEASONS.join(' / ')}`)
    }

    const data = await getHomeSchedule({
      year,
      season,
      force: force === '1' || force === 'true',
      log: req.log,
    })
    res.json({ ok: true, data })
  } catch (err) {
    next(err)
  }
})
