/**
 * 作品详情路由 —— 点击海报后侧边面板调它
 * 与 home.js 同构：只做「校验 id + 调聚合层 + 返回信封」
 */
import { Router } from 'express'
import { getAnimeDetail, getAnimeSubgroups, getSubgroupReleases } from '../api/pages/anime.js'
import { fail } from '../lib/errors.js'

export const animeRouter = Router()

/** 解析并校验路径里的作品主键（前端卡片里的 item.id） */
function animeIdOf(req) {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0) throw fail('BAD_REQUEST', 'id 需要是正整数')
  return id
}

/**
 * GET /api/anime/:id
 * id 是**作品主键**，不是 mikanId / bgmId ——
 * 来源 id 会随换源变，主键不会，面板/路由/缓存都用它才有稳定身份。
 */
animeRouter.get('/anime/:id', (req, res, next) => {
  try {
    res.json({ ok: true, data: getAnimeDetail(animeIdOf(req), { log: req.log }) })
  } catch (err) {
    next(err)
  }
})

/**
 * GET /api/anime/:id/subgroups
 * 面板「资源」区的第一级：字幕组列表（库里优先，空了才现场补一次）
 */
animeRouter.get('/anime/:id/subgroups', async (req, res, next) => {
  try {
    res.json({ ok: true, data: await getAnimeSubgroups(animeIdOf(req), { log: req.log }) })
  } catch (err) {
    next(err)
  }
})

/**
 * GET /api/anime/:id/releases?subgroupId=123
 * 第二级：某字幕组的资源列表。subgroupId 是 subgroup 表主键（第一级接口给的 id）
 */
animeRouter.get('/anime/:id/releases', async (req, res, next) => {
  try {
    const id = animeIdOf(req)
    const subgroupId = Number(req.query.subgroupId)
    if (!Number.isInteger(subgroupId) || subgroupId <= 0) {
      throw fail('BAD_REQUEST', 'subgroupId 需要是正整数（用 /subgroups 接口返回的 id）')
    }
    res.json({ ok: true, data: await getSubgroupReleases(id, subgroupId, { log: req.log }) })
  } catch (err) {
    next(err)
  }
})
