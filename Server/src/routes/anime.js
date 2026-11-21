/**
 * 作品详情路由 —— 点击海报后侧边面板调它
 * 与 home.js 同构：只做「校验 id + 调聚合层 + 返回信封」
 */
import { Router } from 'express'
import { aiSearchAnime, fillAnimeCards, getAnimeDetail, getAnimeSeries, getAnimeSubgroups, getSubgroupReleases } from './../api/pages/anime.js'
import { searchByKeyword } from './../db/anime.js'
import { toCardItem } from './../api/mappers/home.js'
import { fail } from './../lib/errors.js'

export const animeRouter = Router()

/** 解析并校验路径里的作品主键（前端卡片里的 item.id） */
function animeIdOf(req) {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0) throw fail('BAD_REQUEST', 'id 需要是正整数')
  return id
}

/**
 * GET /api/anime?q=关键词 —— 搜索页用
 * ---------------------------------------------------------------------------
 * 只搜标题（BGM 中文名 / Mikan 标题 / BGM 原名），返回卡片 DTO（与首页同一个映射），
 * 前端拿到的形状和首页卡片一致 —— 搜索页不用写第二套渲染。
 * 空 q → 400：不做"返回全部"，那是另一个接口，别让搜索页变成全量导出。
 */
animeRouter.get('/anime', (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim()
    if (!q) throw fail('BAD_REQUEST', 'q 不能为空')
    if (q.length > 80) throw fail('BAD_REQUEST', 'q 太长（上限 80 字）')
    const rows = searchByKeyword(q, 30)
    res.json({ ok: true, data: { q, total: rows.length, items: rows.map(toCardItem) } })
  } catch (err) {
    next(err)
  }
})

/**
 * GET /api/anime/ai-search?q=一句话 —— 搜索页的「AI」模式
 * ---------------------------------------------------------------------------
 * AI 只做「自然语言 → 关键词 / 筛选条件 / 推荐 id」的翻译，结果仍由确定性搜索给出
 * （可解释、可回退、不编造）。没配 AI → 501 AI_DISABLED，前端据此退回普通搜索。
 * 必须注册在 `/anime/:id` 之前，否则会被当成 id="ai-search"。
 */
animeRouter.get('/anime/ai-search', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim()
    if (!q) throw fail('BAD_REQUEST', 'q 不能为空')
    if (q.length > 120) throw fail('BAD_REQUEST', 'q 太长（上限 120 字）')
    res.json({ ok: true, data: await aiSearchAnime(q, { log: req.log }) })
  } catch (err) {
    next(err)
  }
})

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

/**
 * POST /api/anime/fill —— 批量补卡片（首页/发现页「慢慢填上」的后端）
 * ---------------------------------------------------------------------------
 * body: `{ ids: [1,2,3] }`，一次最多 24 个（多了前端自己分批）。
 * 返回**补成功的那几张卡的 DTO**，前端按 id 合并进现有列表 —— 补不成的留在原样
 * （显示「暂无评分」），不会因为一条上游失败而让整批消失。
 */
animeRouter.post('/anime/fill', async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : []
    if (!ids.length) throw fail('BAD_REQUEST', 'ids 需要是非空数组')
    if (ids.length > 60) throw fail('BAD_REQUEST', 'ids 一次最多 60 个')
    const data = await fillAnimeCards(ids, { log: req.log })
    res.json({ ok: true, data })
  } catch (err) {
    next(err)
  }
})
