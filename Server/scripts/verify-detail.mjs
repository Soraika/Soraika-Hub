/**
 * 详情接口验收 —— 侧边详情面板的数据源（「纯读库」那条路径）
 * ---------------------------------------------------------------------------
 * 用法：由 `npm run verify` 串联执行，也可单独 `node --env-file-if-exists=.env scripts/verify-detail.mjs`
 * 隔离：独立端口（默认 3302，可用 VERIFY_DETAIL_PORT 覆盖），不与开发实例抢端口
 * 重点断言：字段齐全、清单/详情的口径不分叉（同一部作品的卡片与详情必须一致）、
 *           外链拼好、只读库（重复请求结果一致，不触发上游）
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { revisionOf } from '../src/lib/format.js'

const PORT = Number(process.env.VERIFY_DETAIL_PORT || 3302)
const base = `http://127.0.0.1:${PORT}`

let failed = 0
const check = (ok, msg) => {
  if (!ok) failed++
  console.log(`${ok ? '✓' : '✗'} ${msg}`)
}

const logs = []
const child = spawn(process.execPath, ['--env-file-if-exists=.env', 'src/index.js'], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.on('data', (d) => logs.push(String(d)))
child.stderr.on('data', (d) => logs.push(String(d)))

const get = async (path) => {
  const res = await fetch(base + path)
  let body = null
  try {
    body = await res.json()
  } catch {
    /* 非 JSON 响应 */
  }
  return { res, body }
}

const waitReady = async () => {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await get('/api/health')).res.ok) return
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('服务没起来')
}

try {
  await waitReady()

  /* ── 拿一张真实卡片当样本（详情按作品主键取，主键由首页下发） ────────── */
  const home = (await get('/api/home/schedule')).body?.data
  const cards = home?.days?.flatMap((d) => d.items) || []
  const card = cards.find((c) => c.score != null && c.bgmId) || cards[0]
  check(Boolean(card?.id), `从首页拿到样本卡片 → id=${card?.id}`)

  /* ── 字段与文案口径 ─────────────────────────────────────────────────── */
  const detail = (await get(`/api/anime/${card.id}`)).body?.data
  const fields = [
    'id', 'title', 'titleOriginal', 'poster',
    'score', 'scoreText', 'ratingText', 'watchingText', 'epsText',
    'seasonText', 'weekdayText', 'airDate',
    'tags', 'summary', 'bgmId', 'mikanId', 'bgmUrl', 'mikanUrl',
  ]
  check(fields.every((f) => detail && f in detail), `详情字段齐全（${fields.length} 个）`)

  check(detail.id === card.id, `按主键取回同一部 → id=${detail.id}`)
  check(detail.title === card.title, `详情标题与卡片一致 → ${detail.title}`)
  const isPosterAddr = (p) => p === '' || p.startsWith('/api/img/anime/') || /^https?:\/\//.test(p)
  check(
    isPosterAddr(detail.poster) && isPosterAddr(card.poster),
    // 两者**不必逐字相等**：后台预热一旦把图存到本地，地址就会从「图源直链」变成「本地入口」
    `海报地址同规则（详情 ${String(detail.poster).slice(0, 46)} / 卡片 ${String(card.poster).slice(0, 46)}）`,
  )
  check(detail.score === card.score && detail.ratingText === card.ratingText, `评分口径与卡片不分叉 → ${detail.score} / ${detail.ratingText}`)
  check(
    detail.scoreText === card.scoreText && (detail.score == null || detail.scoreText === Number(detail.score).toFixed(1)),
    `评分成品字符串一位小数且与卡片不分叉 → ${detail.scoreText || '（无）'}`,
  )

  check(Array.isArray(detail.tags) && detail.tags.length <= 8, `标签是数组且 ≤ 8 个 → ${detail.tags.length} 个`)

  /* 标签口径：平台 / 媒体形式 / 地域类不给前端（库里的标签几乎都以 TV / 日本 开头），
     且详情标签的前两个必须与卡片信息行里那两个题材**完全一致**（同源同算法，不许分叉） */
  const BLOCKED = ['TV', 'WEB', 'OVA', 'OAD', 'ONA', '剧场版', '电影', '日本', '中国', '韩国', '美国', '欧美', '国产']
  check(detail.tags.every((t) => !BLOCKED.includes(t)), `标签已过滤平台/地域类 → ${detail.tags.join(' / ')}`)
  const cardThemes = (String(card.metaText || '').split('·').pop() || '')
    .trim()
    .split(/\s+/)
    .filter((t) => t && !t.includes('人在看'))
  check(
    cardThemes.every((t, i) => detail.tags[i] === t),
    `卡片信息行与详情标签同口径 → 卡片[${cardThemes.join(' ')}] = 详情[${detail.tags.slice(0, cardThemes.length).join(' ')}]`,
  )

  check(typeof detail.summary === 'string', `简介是字符串（可空）→ ${detail.summary.length} 字`)
  check(detail.seasonText === '' || /^\d{4}/.test(detail.seasonText), `放送文案是成品字符串 → ${detail.seasonText}`)
  check(detail.epsText === '' || /话$/.test(detail.epsText), `集数文案是成品字符串 → ${detail.epsText}`)
  check(detail.watchingText === '' || /人在看$/.test(detail.watchingText), `在看文案是成品字符串 → ${detail.watchingText}`)
  check(detail.weekdayText === '' || typeof detail.weekdayText === 'string', `放送星期是成品字符串 → ${detail.weekdayText}`)
  check(detail.titleOriginal === '' || detail.titleOriginal !== detail.title, `原名与主标题不重复 → ${detail.titleOriginal || '（无）'}`)

  check(!detail.bgmId || detail.bgmUrl === `https://bgm.tv/subject/${detail.bgmId}`, `Bangumi 外链已拼好 → ${detail.bgmUrl}`)
  check(!detail.mikanId || detail.mikanUrl.endsWith(`/Home/Bangumi/${detail.mikanId}`), `Mikan 外链已拼好 → ${detail.mikanUrl}`)

  /* ── 修订版：各字幕组叫法不一（v2 / 修正版 / Rework / Repack），统一归一成数字 ── */
  check(revisionOf('[A] 番名 - 04 [1080P]') === 1, '没标版本 = 原版（1）')
  check(revisionOf('[A] 番名 - 04v2 [1080P]') === 2, `v2 → ${revisionOf('[A] 番名 - 04v2 [1080P]')}`)
  check(revisionOf('[A] 番名 - 04 [V3] [1080P]') === 3, 'V3 → 3')
  check(revisionOf('[A] 番名 - 04 [修正版]') === 2 && revisionOf('[A] 番名 - 04 [Rework]') === 2, '中文「修正版」与 Rework 都算修订')
  check(revisionOf('[A] 番名 - 04 [Repack2]') === 2 && revisionOf('[A] 番名 - 04 [第3版]') === 3, 'Repack / 第N版 也认')
  check(
    revisionOf('[A] 番名 - 04 [1080P][HEVC][x264]') === 1 && revisionOf('[A] 番名 - 04 [AVC][AAC]') === 1,
    '不误伤 1080P / HEVC / x264 / AVC',
  )

  /* ── 纯读库：重复请求结果必须一致（面板可反复开关，不该每次都变） ─────── */
  const again = (await get(`/api/anime/${card.id}`)).body?.data
  check(JSON.stringify(again) === JSON.stringify(detail), '重复请求结果一致（纯读库，不触发上游）')

  /* ── 系列（面板标题旁那个 chip）：**没算过就现场跑一遍**（用户看了啥、库里没有就补一遍）
   * 两种结论都合法：① 现算出系列（items ≥ 2）② 这部确实没有同系列其它成员（null）。
   * 不允许的只有两件事：500 / 返回只有它自己的单成员系列。 */
  const seriesRes = await get(`/api/anime/${card.id}/series`)
  const series = seriesRes.body?.data
  check(
    seriesRes.res.ok && (series === null || (Array.isArray(series.items) && series.items.length >= 2)),
    series
      ? `系列接口现场算出 ${series.items.length} 部（根名「${series.rootTitle}」）`
      : '系列接口：这部确实没有同系列其它成员 → data 为 null（前端据此不渲染 chip）',
  )
  const seriesBad = await get('/api/anime/abc/series')
  check(seriesBad.res.status === 400 && seriesBad.body?.error?.code === 'BAD_REQUEST', '系列接口：非法 id → 400 / BAD_REQUEST')

  /* ── 字幕组（资源区第一级）与资源列表（第二级）──────────────────────── */
  const sgRes = await get(`/api/anime/${card.id}/subgroups`)
  const subgroupData = sgRes.body?.data
  check(
    sgRes.res.ok && Array.isArray(subgroupData?.items),
    `字幕组接口可用 → ${subgroupData?.items?.length} 个（source=${subgroupData?.source}）`,
  )
  check(
    subgroupData.items.every((s) => Number.isInteger(s.id) && typeof s.name === 'string' && 'rssId' in s && 'mikanId' in s),
    `字幕组字段齐全：id / name / mikanId / rssId → ${JSON.stringify(subgroupData.items.slice(0, 2))}`,
  )
  /* 同一个作品下的字幕组不能有重复项（实体表的 id 就是它的身份） */
  check(
    subgroupData.items.every((s, i, arr) => arr.findIndex((x) => x.id === s.id) === i),
    '同一作品下的字幕组不重复（按实体 id 判重）',
  )

  /* ── 表结构：字幕组是「实体 + 关系」两张表（老结构把同一组按作品重复存了几十遍）── */
  const schemaSql = readFileSync(new URL('../src/db/schema.sql', import.meta.url), 'utf8')
  const subgroupTable = (schemaSql.match(/CREATE TABLE IF NOT EXISTS subgroup \([\s\S]*?\n\);/) || [''])[0]
  check(
    subgroupTable.includes('mikan_subgroup_id') && !subgroupTable.includes('anime_id'),
    'subgroup 是实体表：去重键是 mikan_subgroup_id，不再挂 anime_id',
  )
  check(
    /idx_subgroup_mikan ON subgroup\(mikan_subgroup_id\)/.test(schemaSql),
    '实体表对 mikan_subgroup_id 建了唯一索引（重复写入会去重，不会堆积成 1900 行）',
  )
  const linkTable = (schemaSql.match(/CREATE TABLE IF NOT EXISTS anime_subgroup \([\s\S]*?\n\);/) || [''])[0]
  check(
    /PRIMARY KEY \(anime_id, subgroup_id\)/.test(linkTable) && /WITHOUT ROWID/.test(linkTable),
    'anime_subgroup 是关联表：复合主键即身份，没有多余自增 id',
  )
  check(/rss_id\s+TEXT/.test(linkTable), 'RSS id 存在关联表上（同一个组在不同作品下的 RSS id 不同）')

  /* 取资源列表用的是**RSS 字幕组 id**（页面上 div.subgroup-text[id]），不是发布组 id */
  const animePageSource = readFileSync(new URL('../src/api/pages/anime.js', import.meta.url), 'utf8')
  check(
    /fetchSubgroupReleases\(row\.mikan_id, subgroup\.subgroup_rss_id\)/.test(animePageSource),
    '取资源用 RSS 字幕组 id（subgroup_rss_id），不是发布组 id',
  )

  if (subgroupData.items.length) {
    const firstSg = subgroupData.items[0]
    const relRes = await get(`/api/anime/${card.id}/releases?subgroupId=${firstSg.id}`)
    const rel = relRes.body?.data
    check(relRes.res.ok && rel?.subgroup?.id === firstSg.id, `资源接口可用 → 「${firstSg.name}」${rel?.total} 条`)
    check(Array.isArray(rel?.items), '资源列表是数组')
    check(
      rel.items.every((it) => Number.isInteger(it.revision) && it.revision >= 1),
      '每条资源都带修订版号（1 = 原版，>=2 = 字幕组修过）',
    )

    const sample = rel.items[0]
    if (sample) {
      check(typeof sample.title === 'string' && sample.title.length > 0, `资源标题 → ${sample.title.slice(0, 40)}`)
      check(
        !sample.magnet || /^magnet:\?xt=urn:btih:[0-9a-f]{40}$/i.test(sample.magnet),
        `磁力链接由 info hash 拼成 → ${String(sample.magnet).slice(0, 46)}…`,
      )
      check(sample.sizeText === '' || / (B|KB|MB|GB|TB)$/.test(sample.sizeText), `大小是成品字符串 → ${sample.sizeText}`)
      check(
        sample.publishedText === '' || /^\d{2}-\d{2} \d{2}:\d{2}$/.test(sample.publishedText),
        `时间是成品字符串 → ${sample.publishedText}`,
      )
    }

    const again2 = (await get(`/api/anime/${card.id}/releases?subgroupId=${firstSg.id}`)).body?.data
    check(
      again2?.cached === false && again2.total === rel.total,
      `资源列表**不缓存**、每次直连上游 → cached=${again2?.cached}（总数稳定=${rel.total}）`,
    )

    // 归属校验：前端传来的 subgroupId 必须先确认属于这部作品
    const wrongSg = await get(`/api/anime/${card.id}/releases?subgroupId=99999999`)
    check(wrongSg.res.status === 404 && wrongSg.body?.error?.code === 'NOT_FOUND', '不属于该作品的字幕组 → 404 / NOT_FOUND')
    const badSgId = await get(`/api/anime/${card.id}/releases?subgroupId=abc`)
    check(badSgId.res.status === 400 && badSgId.body?.error?.code === 'BAD_REQUEST', '非法 subgroupId → 400 / BAD_REQUEST')
  }

  const noSg = await get('/api/anime/99999999/subgroups')
  check(noSg.res.status === 404, '不存在的作品取字幕组 → 404')

  /* ── 错误路径 ───────────────────────────────────────────────────────── */
  const notFound = await get('/api/anime/99999999')
  check(notFound.res.status === 404 && notFound.body?.error?.code === 'NOT_FOUND', '不存在的 id → 404 / NOT_FOUND')
  const badId = await get('/api/anime/abc')
  check(badId.res.status === 400 && badId.body?.error?.code === 'BAD_REQUEST', '非数字 id → 400 / BAD_REQUEST')

  console.log(failed ? `\n✗ 失败 ${failed} 项` : '\n✓ 全部通过')
  process.exitCode = failed ? 1 : 0
} catch (err) {
  console.error('\n✗ 验收中断：', err.message)
  console.error(logs.join('').slice(-1500))
  process.exitCode = 1
} finally {
  child.kill()
}
