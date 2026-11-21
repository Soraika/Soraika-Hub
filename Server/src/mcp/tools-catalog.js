/**
 * MCP 只读工具 —— 全站动画库 + 排期 + 系列链 + 字幕组/资源
 * ---------------------------------------------------------------------------
 * 分工：本文件只**读**（搜索 / 详情 / 推荐 / 标签 / 排期 / 系列 / 资源列表），
 * 会改动任何东西的工具在 `tools-downloads.js`，那一组要 `mcp.allowWrite` 才放行。
 *
 * 三个设计约束（决定了这些工具长什么样）：
 *   ① **离线优先**：绝大多数工具只查本地 SQLite（全站 3 万部动画 + 标签倒排 + 关系边），
 *      一条上游请求都不发 —— agent 可以放心连问十个问题，不会被限流也不会慢。
 *      只有「取字幕组 / 取资源列表」必须上网（那是 Mikan 的实时数据，没有离线源）。
 *   ② **结果要有上限**：`mcp.maxResults` 兜底，每条结果都裁到模型能消化的长度
 *      （简介截断、标签只给前几个）。给 agent 塞 300 条等于没给。
 *   ③ **id 的双轨要说清**：`bgmId`（Bangumi 条目 id，全站唯一）和 `animeId`（本库主键，
 *      只有排期里有的作品才有）。工具参数名据此区分，返回值两个都给。
 */
import { config } from '../config.js'
import { getAnimeDetail, getAnimeSubgroups, getAnimeSeries, getSubgroupReleases } from '../api/pages/anime.js'
import { listBySeason } from '../db/anime.js'
import { catalogDetail, catalogStats, recommendCatalog, searchCatalog, tagCloud, toCatalogRow } from '../db/catalog.js'
import { fail } from '../lib/errors.js'

/** 单次返回上限：配置值兜底，且不超过工具自己声明的上限 */
const limitOf = (asked, hardCap = 40) => {
  const cfg = Number(config.mcp?.maxResults) || 20
  const n = Number(asked)
  const value = Number.isFinite(n) && n > 0 ? n : cfg
  return Math.max(1, Math.min(value, cfg > hardCap ? cfg : hardCap, hardCap))
}

/** 简介截断：模型不需要 3000 字简介 */
const shortSummary = (text, max = 220) => {
  const s = String(text || '').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/** 排期行（`anime` 表）→ 紧凑对象 */
const scheduleRow = (row) => ({
  animeId: row.id,
  bgmId: row.bgm_id || null,
  title: row.title_bgm || row.title_mikan || row.title_bgm_origin || '',
  titleMikan: row.title_mikan || null,
  score: row.score ?? null,
  year: row.year ?? null,
  season: row.season ?? null,
  weekday: row.weekday ?? null,
  episodes: row.total_episodes ?? null,
})

const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六', '剧场版', 'OVA']

export const catalogTools = [
  {
    name: 'search_anime',
    title: '搜索动画',
    write: false,
    description:
      '在本地全站动画库里搜索（约 3 万部，离线、秒回）。可按题名关键词、年份、季度、标签、评分、话数、平台筛选；' +
      'inLibrary=true 只看已在本库（已入库/可下载）的，false 只看库里还没有的。适合「找几部 2020 年后的高分机战番」这类问题。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '题名 / 别名 / 简介里的关键词（中日英都行，子串匹配）' },
        year: { type: 'integer', description: '放送年份，例如 2020' },
        season: { type: 'string', enum: ['冬', '春', '夏', '秋'], description: '放送季度' },
        tags: { type: 'array', items: { type: 'string' }, description: '必须同时具备的标签（交集），如 ["机战","原创"]' },
        minScore: { type: 'number', description: 'Bangumi 评分下限，如 8' },
        maxEps: { type: 'integer', description: '话数上限（想找短番就填 13）' },
        platform: { type: 'string', enum: ['TV', 'OVA', '剧场版', 'Web'], description: '平台' },
        inLibrary: { type: 'boolean', description: 'true=只要本库已有的；false=只要本库还没有的' },
        order: { type: 'string', enum: ['score', 'rank', 'newest', 'oldest', 'popular', 'eps'], description: '排序，默认按评分' },
        limit: { type: 'integer', description: '返回条数（默认 20，上限 40）' },
        includeNsfw: { type: 'boolean', description: '是否包含 R18（默认否）' },
      },
    },
    async handler(args = {}) {
      const { rows, total } = searchCatalog({ ...args, limit: limitOf(args.limit) })
      return {
        total,
        count: rows.length,
        filters: Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined && v !== null)),
        items: rows.map((row) => toCatalogRow(row)),
      }
    },
  },

  {
    name: 'get_anime',
    title: '动画详情',
    write: false,
    description:
      '取一部动画的完整档案：评分与各档人数、排名、标签（含出现次数）、简介、放送日、话数、别名、staff（导演 / 动画制作 / 系列构成等）。' +
      '传 bgmId（Bangumi id）或 animeId（本库 id）都行；本库有的会额外返回排期与海报地址。',
    inputSchema: {
      type: 'object',
      properties: {
        bgmId: { type: 'string', description: 'Bangumi 条目 id' },
        animeId: { type: 'integer', description: '本库作品 id（只有排期里有的作品才有）' },
      },
    },
    async handler({ bgmId, animeId } = {}) {
      if (bgmId) {
        const detail = catalogDetail(bgmId)
        if (!detail) throw fail('NOT_FOUND', `本地库里没有 bgmId=${bgmId} 的档案`)
        detail.summary = detail.summary || null
        return detail
      }
      if (animeId) {
        const row = await getAnimeDetail(animeId)
        const detail = row?.bgmId ? catalogDetail(row.bgmId) : null
        return {
          ...(detail || {}),
          animeId: row.id,
          title: row.title || detail?.title,
          score: row.score ?? detail?.score ?? null,
          tags: row.tags?.length ? row.tags : detail?.tags,
          summary: detail?.summary || shortSummary(row.summary),
          year: row.year,
          season: row.season,
          weekday: row.weekday,
          episodes: row.totalEpisodes ?? detail?.episodes ?? null,
          posterUrl: row.posterUrl || detail?.library?.posterUrl || null,
          aiTags: row.aiTags ?? null,
        }
      }
      throw fail('BAD_REQUEST', '要么传 bgmId，要么传 animeId')
    },
  },

  {
    name: 'recommend_anime',
    title: '按口味推荐',
    write: false,
    description:
      '按标签推荐动画：给几个标签（如 ["机战","科幻"]），返回命中标签最多、评分最高的若干部（离线，不打上游）。' +
      '可以用 yearFrom / yearTo / maxEps 收窄，用 exclude 排除已经看过或库里已有的。不给标签就退回高分榜。',
    inputSchema: {
      type: 'object',
      properties: {
        tags: { type: 'array', items: { type: 'string' }, description: '口味标签，如 ["机战","原创","治愈"]' },
        minScore: { type: 'number', description: '评分下限，默认 7' },
        yearFrom: { type: 'integer', description: '放送年份下限' },
        yearTo: { type: 'integer', description: '放送年份上限' },
        maxEps: { type: 'integer', description: '话数上限' },
        limit: { type: 'integer', description: '返回条数（默认 12）' },
        exclude: { type: 'array', items: { type: 'string' }, description: '要排除的 bgmId 列表' },
        excludeLibrary: { type: 'boolean', description: 'true = 排除本库已有的（推荐"还没下的"）' },
      },
    },
    async handler(args = {}) {
      let exclude = Array.isArray(args.exclude) ? args.exclude.map(String) : []
      /* 「排除已在库的」在库里查一次：这些是用户已经有的，推荐里再出现很吵 */
      if (args.excludeLibrary) {
        const { rows } = searchCatalog({ inLibrary: true, limit: 100, order: 'score' })
        exclude = [...exclude, ...rows.map((r) => String(r.bgm_id))]
      }
      const result = recommendCatalog({
        tags: args.tags || [],
        exclude,
        minScore: args.minScore,
        yearFrom: args.yearFrom,
        yearTo: args.yearTo,
        maxEps: args.maxEps,
        limit: limitOf(args.limit, 30),
      })
      return {
        tags: result.tags,
        count: result.rows.length,
        items: result.rows.map((row) => ({ ...row })),
        hint: result.tags.length
          ? 'matchedTags 是命中的标签；分值相同按评分排。'
          : '没给标签，返回的是高分榜。',
      }
    },
  },

  {
    name: 'list_tags',
    title: '标签榜',
    write: false,
    description: '列出库里最常用的标签（按部数倒序），用来知道「能按哪些标签筛 / 推荐」。可设评分下限只统计好番。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '返回多少个（默认 60）' },
        minScore: { type: 'number', description: '只统计评分 >= 这个值的动画，默认 7' },
      },
    },
    async handler(args = {}) {
      return { items: tagCloud({ limit: limitOf(args.limit, 120), minScore: args.minScore ?? 7 }) }
    },
  },

  {
    name: 'catalog_stats',
    title: '库概况',
    write: false,
    description: '动画库的整体情况：共多少部、多少部有评分、多少标签、staff 与简介覆盖率、最早/最新放送日。适合先摸清家底。',
    inputSchema: { type: 'object', properties: {} },
    async handler() {
      return catalogStats()
    },
  },

  {
    name: 'list_season',
    title: '某季排期',
    write: false,
    description:
      '读本库的季度排期（来自 Mikan，含星期几）。只读库，不刷新上游；库里没有这一季就返回空（要去首页点一次该季才会入库）。',
    inputSchema: {
      type: 'object',
      properties: {
        year: { type: 'integer', description: '年份，默认今年' },
        season: { type: 'string', enum: ['冬', '春', '夏', '秋'], description: '季度，默认按当前月份推' },
        weekday: { type: 'integer', description: '0=周日…6=周六；7=剧场版；8=OVA。不传返回全周' },
        limit: { type: 'integer', description: '返回条数上限，默认 60' },
      },
    },
    async handler(args = {}) {
      const now = new Date()
      const m = now.getMonth() + 1
      const guess = m <= 3 ? '冬' : m <= 6 ? '春' : m <= 9 ? '夏' : '秋'
      const year = Number(args.year) || now.getFullYear()
      const season = args.season || guess
      const rows = listBySeason(year, season)
      const filtered = args.weekday === undefined || args.weekday === null ? rows : rows.filter((r) => r.weekday === Number(args.weekday))
      const cap = limitOf(args.limit, 120)
      return {
        year,
        season,
        total: filtered.length,
        count: Math.min(filtered.length, cap),
        truncated: filtered.length > cap,
        items: filtered.slice(0, cap).map((row) => ({ ...scheduleRow(row), weekdayText: WEEKDAY_NAMES[row.weekday] ?? null })),
      }
    },
  },

  {
    name: 'get_series',
    title: '系列链',
    write: false,
    description: '取一部作品所在系列的全部成员（按季位排序），返回根名与每部的季位。用来回答「这个系列看片顺序是什么」。',
    inputSchema: {
      type: 'object',
      properties: { animeId: { type: 'integer', description: '本库作品 id' } },
      required: ['animeId'],
    },
    async handler({ animeId } = {}) {
      const data = await getAnimeSeries(animeId)
      if (!data) return { animeId, found: false, members: [] }
      return { animeId, found: true, ...data }
    },
  },

  {
    name: 'list_subgroups',
    title: '字幕组列表',
    write: false,
    description:
      '取一部作品下有哪些字幕组（实时问 Mikan，需要联网）。返回的 id 是「该作品下的 rss id」，拿去调 list_releases。',
    inputSchema: {
      type: 'object',
      properties: { animeId: { type: 'integer', description: '本库作品 id' } },
      required: ['animeId'],
    },
    async handler({ animeId } = {}) {
      if (!animeId) throw fail('BAD_REQUEST', '需要 animeId')
      return await getAnimeSubgroups(animeId)
    },
  },

  {
    name: 'list_releases',
    title: '资源列表',
    write: false,
    description:
      '取某作品某字幕组下的资源（集数 / 画质 / 是否已下载），实时问 Mikan。拿到 items 之后可以用 add_download 直接下。',
    inputSchema: {
      type: 'object',
      properties: {
        animeId: { type: 'integer', description: '本库作品 id' },
        subgroupId: { type: ['integer', 'string'], description: 'list_subgroups 返回的 id（该作品下的 rss id）' },
        limit: { type: 'integer', description: '返回条数，默认 40' },
      },
      required: ['animeId', 'subgroupId'],
    },
    async handler({ animeId, subgroupId, limit } = {}) {
      if (!animeId || !subgroupId) throw fail('BAD_REQUEST', '需要 animeId 与 subgroupId')
      const data = await getSubgroupReleases(animeId, subgroupId)
      const items = Array.isArray(data?.items) ? data.items : []
      const cap = limitOf(limit, 120)
      return {
        animeId,
        subgroupId,
        total: items.length,
        count: Math.min(items.length, cap),
        items: items.slice(0, cap),
        source: data?.source ?? null,
      }
    },
  },
]
