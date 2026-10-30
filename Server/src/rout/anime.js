/**
 * 作品详情路由 —— 点击海报后侧边面板调它
 * 与 home.js 同构：只做「校验 id + 调聚合层 + 返回信封」
 */
import { Router } from 'express'
import { getAnimeDetail, getAnimeSeries, getAnimeSubgroups, getSubgroupReleases } from '../api/pages/anime.js'
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
animeRouter.get('/anime/:id', async (req, res, next) => {
  try {
    res.json({ ok: true, data: await getAnimeDetail(animeIdOf(req), { log: req.log }) })
  } catch (err) {
    next(err)
  }
})

/**
 * GET /api/anime/:id/series
 * 同系列的作品（面板标题旁的「系列」chip 点开用）。**没算过就现场跑一遍走链**；
 * 真的没有别的成员时 data 为 null（不是错误）。
 */
animeRouter.get('/anime/:id/series', async (req, res, next) => {
  try {
    res.json({ ok: true, data: await getAnimeSeries(animeIdOf(req), { log: req.log }) })
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
 * 第二级：某字幕组的资源列表。subgroupId 就是 `/subgroups` 返回的那个 id
 * （= 该作品下的 RSS id；映射不再落库，服务端直接拿它去问 Mikan）
 */
animeRouter.get('/anime/:id/releases', async (req, res, next) => {
  try {
    const id = animeIdOf(req)
    const raw = String(req.query.subgroupId ?? '')
    // 三种都能传：
    //   · 正整数 = 该作品下的字幕组 RSS id（详情页正常时 /subgroups 给的就是它）
    //   · 'all'  = 全部资源
    //   · 其它字符串 = **组名**（详情页 404 时由 AI 分类得出，/subgroups 直接把组名当 id 给前端）
    const isAll = raw === 'all'
    const isId = /^\d+$/.test(raw) && Number(raw) > 0
    const isLabel = !isAll && !isId && raw.length > 0 && raw.length <= 80
    if (!isAll && !isId && !isLabel) {
      throw fail('BAD_REQUEST', 'subgroupId 需要是正整数（/subgroups 的 id）、组名，或 all 表示全部')
    }
    const subgroupId = isId ? Number(raw) : raw
    res.json({ ok: true, data: await getSubgroupReleases(id, subgroupId, { log: req.log }) })
  } catch (err) {
    next(err)
  }
})
