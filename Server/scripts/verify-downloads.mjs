/**
 * 下载接口验收 —— qBittorrent 接入（版本 / 卡片墙 / 面板分组 / 加种参数）
 * ---------------------------------------------------------------------------
 * 用法：`node scripts/verify-downloads.mjs`（独立端口 3305，不抢开发实例）
 *
 * 两类断言：
 *   ① **纯函数**（lib/downloads.js）：老种子的标签/名字怎么认回作品与组、集数怎么取、
 *      归档目录怎么拼 —— 这些是「下载页能不能把盘上的文件对上作品」的全部依据，必须钉住
 *   ② **真接口**：qB 没配时也要给结构化空值（页面显示引导），配了就要有卡有组；
 *      错误路径（坏 id / 没配）各自的响应码
 * qB 是外部服务：**没配/连不上不算失败**（只打一行跳过提示），其它断言照跑。
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import {
  archiveDirOf,
  buildTags,
  episodeOf,
  episodeOrder,
  kindOf,
  mikanIdOf,
  seasonIndexOf,
  sizeText,
  splitSavePath,
  stateTextOf,
  subgroupOf,
} from '../src/lib/downloads.js'

const PORT = Number(process.env.VERIFY_DOWNLOADS_PORT || 3305)
const base = `http://127.0.0.1:${PORT}`

let failed = 0
const check = (ok, msg) => {
  if (!ok) failed++
  console.log(`${ok ? '✓' : '✗'} ${msg}`)
}

/* ══════════════════════════════════════════════════════════════════════════
   ① 纯函数：老种子的三种「身份来源」
   ══════════════════════════════════════════════════════════════════════════ */

/* 旧系统把身份塞进标签：soraika:[番剧id][番名][季][集][组rssId][组名] */
const legacyTag = 'soraika:[3990][与奔驰于透明之夜的你][1][04][203][桜都字幕组]'
check(mikanIdOf(legacyTag) === '3990', `旧标签里取 Mikan 番剧 id → ${mikanIdOf(legacyTag)}`)
check(subgroupOf(legacyTag) === '桜都字幕组', `旧标签里取字幕组名 → ${subgroupOf(legacyTag)}`)
check(episodeOf(legacyTag) === '04', `旧标签里的集数 → ${episodeOf(legacyTag)}`)

/* 另外 50 条老种子**标签是空的**，名字本身就是旧格式 —— 必须也能认出来 */
const legacyName = '[4014][碧蓝之海][3][06][34][极影字幕社]'
check(mikanIdOf('', legacyName) === '4014', `标签空、从种子名认番剧 id → ${mikanIdOf('', legacyName)}`)
check(subgroupOf('', legacyName) === '极影字幕社', `标签空、从种子名认字幕组 → ${subgroupOf('', legacyName)}`)
check(episodeOf(legacyName) === '06', `标签空、从种子名取集数 → ${episodeOf(legacyName)}`)

/* 新写法：mid: / sg:（加种时写的就是这一套，读写必须对称） */
const newTags = buildTags({ mikanId: '4037', subgroup: '樱桃花字幕组' })
check(mikanIdOf(newTags) === '4037' && subgroupOf(newTags) === '樱桃花字幕组', `新标签读写对称 → ${newTags}`)
check(/^soraika,/.test(newTags), '新标签带 soraika 标记（qB 里能一键筛出自己的种子）')

/* 旧系统写坏的数据：`[2][21][null][null]` —— null 不是组名 */
const brokenTag = 'soraika:[4037][相反的你和我 第二季][2][21][null][null]'
check(subgroupOf(brokenTag) === '', `组名是 "null" 的脏数据不当成组名 → 「${subgroupOf(brokenTag)}」`)

/* 番剧 id 不能被当成集数（踩过：显示成「最新 4114 集」） */
check(episodeOf('[4114][黑暗召唤师][1][null][370][LoliHouse]') === '', '认不出集数时回空串，不拿番剧 id 冒充')

/* 集数：改名后的规范写法优先，合集取区间 */
check(episodeOf('相反的你和我 S02E23.mkv') === '23', `SxxEyy → ${episodeOf('相反的你和我 S02E23.mkv')}`)
check(episodeOf('[Nekomoe kissaten][Yuru Camp][01-12END][1080p]') === '01-12', '合集范围 → 01-12')
check(episodeOrder('01-12') === 12, `合集按区间右端排序 → ${episodeOrder('01-12')}`)
check(episodeOrder('04') === 4 && episodeOrder('') === 0, '单集按数字排序，认不出排最后')

/* 目录与状态 */
const split = splitSavePath('/downloads/anime/碧蓝之海/SE03')
check(split.title === '碧蓝之海' && split.seasonDir === 'SE03', `归档路径拆番名/季目录 → ${split.title} / ${split.seasonDir}`)
check(seasonIndexOf('SE01') === 1 && seasonIndexOf('Season 02') === 2 && seasonIndexOf('') === 0, '季目录新旧两种写法都认')
check(kindOf('stoppedUP') === 'done' && kindOf('stalledDL') === 'downloading' && kindOf('missingFiles') === 'missing', 'qB 状态归四类（完成/下载中/丢失）')
check(stateTextOf('stalledDL') === '下载中（无进度）', `状态文案说人话 → ${stateTextOf('stalledDL')}`)
check(sizeText(1024 * 1024 * 1024) === '1.0 GB' && sizeText(0) === '', `体积文案 → ${sizeText(1024 * 1024 * 1024) || '(空)'}`)

/* 归档目录：新下载一律 `{根}/{番名}/Season 01` */
check(
  archiveDirOf({ title: '碧蓝之海', season: 3 }) === '/downloads/anime/碧蓝之海/Season 03',
  `归档目录规范 → ${archiveDirOf({ title: '碧蓝之海', season: 3 })}`,
)
check(
  archiveDirOf({ title: '某个/带斜杠的番名', season: 0 }) === '/downloads/anime/某个_带斜杠的番名',
  '番名里的路径字符被替换；剧场版（season=0）不建季目录',
)


/* ══════════════════════════════════════════════════════════════════════════
   ② 真接口（起一个隔离实例）
   ══════════════════════════════════════════════════════════════════════════ */

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
    /* 非 JSON */
  }
  return { res, body }
}
const post = async (path, payload) => {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  let body = null
  try {
    body = await res.json()
  } catch {
    /* 非 JSON */
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

  /* ── qB 状态 ────────────────────────────────────────────────────────── */
  const status = await get('/api/qb/status')
  check(status.res.status === 200 && status.body?.ok === true, 'GET /api/qb/status → 200 且信封正常')
  const configured = Boolean(status.body?.data?.configured)
  console.log(configured ? '  （qB 已配置，跑真数据断言）' : '  （qB 未配置：只验空结构）')
  if (configured) {
    const v = status.body.data.versions || {}
    check(Boolean(v.app && v.api), `**两个版本都回**（应用 ${v.app} / WebAPI ${v.api}）`)
    check(/^v?\d+\.\d+/.test(v.app), `应用版本是版本号形状 → ${v.app}`)
  }

  /* ── 卡片墙 ────────────────────────────────────────────────────────── */
  const list = await get('/api/downloads')
  const d = list.body?.data || {}
  check(list.res.status === 200 && d.configured === configured, `GET /api/downloads → 200（configured=${d.configured}）`)
  check(['counts', 'items', 'unmatched'].every((k) => k in d), '返回带 counts / items / unmatched 三块')
  check(Array.isArray(d.items) && Array.isArray(d.unmatched), 'items 与 unmatched 都是数组')

  if (configured) {
    const items = d.items || []
    check(items.length > 0, `卡片墙非空 → ${items.length} 部`)
    check(
      items.every(
        (it) =>
          Number.isInteger(it.id) &&
          typeof it.title === 'string' &&
          typeof it.state === 'string' &&
          Array.isArray(it.seasons) &&
          Number.isInteger(it.count),
      ),
      '每张卡都带 id / title / state / seasons / count（CardGrid 要 id 当 key）',
    )
    check(
      items.every((it) => ['downloading', 'done', 'missing', 'error'].includes(it.state)),
      '卡片状态落在四类里（下载中 / 已完成 / 丢失 / 出错）',
    )
    const c = d.counts || {}
    check(typeof c.total === 'number' && c.total > 0, `counts.total 是数字 → ${c.total}`)
    check(typeof c.sizeText === 'string' && /GB|MB|B/.test(c.sizeText || ''), `总量文案 → ${c.sizeText}`)
    // 下载中的卡片排最前（那是「正在发生的事」）
    const lastDown = items.map((it) => it.state).lastIndexOf('downloading')
    const firstOther = items.findIndex((it) => it.state !== 'downloading')
    check(lastDown === -1 || firstOther === -1 || lastDown < firstOther, '下载中的卡片排在已完成之前')

    /* ── 面板：字幕组 → 已下载的集 ─────────────────────────────────────── */
    const sample = items[0]
    const one = await get(`/api/downloads/${sample.id}`)
    const a = one.body?.data || {}
    check(one.res.status === 200 && a.animeId === sample.id, `GET /api/downloads/${sample.id} → 200 且是同一部`)
    check(Array.isArray(a.subgroups) && a.subgroups.length > 0, `按字幕组分组 → ${a.subgroups?.length} 个组`)
    const sg = a.subgroups?.[0] || {}
    check(
      typeof sg.id === 'string' && typeof sg.name === 'string' && Array.isArray(sg.items),
      '每个组带 id / name / items（id 就是组名，与「库里没有的组」同一条路径）',
    )
    const item = sg.items?.[0] || {}
    const itemFields = ['hash', 'name', 'fileName', 'episode', 'sizeText', 'stateText', 'savePath']
    check(itemFields.every((k) => k in item), `组里的条目字段齐全（${itemFields.length} 个）`)
    check(
      (sg.items || []).every((it, i, arr) => i === 0 || episodeOrder(arr[i - 1].episode) >= episodeOrder(it.episode)),
      '组内按集号倒序（最新的在最上面）',
    )
  } else {
    check(d.items.length === 0 && d.unmatched.length === 0, '没配 qB 时 items / unmatched 是空数组（页面据此给引导）')
  }

  /* ── 错误路径 ──────────────────────────────────────────────────────── */
  const badId = await get('/api/downloads/abc')
  check(badId.res.status === 400 && badId.body?.error?.code === 'BAD_REQUEST', '非数字 animeId → 400 / BAD_REQUEST')
  const noAnime = await get('/api/downloads/99999999')
  check(noAnime.res.status === 404 && noAnime.body?.error?.code === 'NOT_FOUND', '不存在的作品 → 404 / NOT_FOUND')
  const emptyAdd = await post('/api/downloads', { animeId: 1, items: [] })
  check(emptyAdd.res.status === 400, '加种时 items 为空 → 400（不做无意义的 qB 请求）')
  const badUrlAdd = await post('/api/downloads', { animeId: 'abc', items: [{ title: 'x' }] })
  check(badUrlAdd.res.status === 400, '加种时 animeId 非法 → 400')

  /* ── 设置页「测试连接」要回两个版本 ─────────────────────────────────── */
  const settingsTest = await post('/api/settings/test', { path: 'qb.base' })
  const t = settingsTest.body?.data
  if (configured && t?.ok) {
    check(Boolean(t.versions?.app), `测试连接带回应用版本 → ${t.versions.app}`)
    check(Boolean(t.versions?.api), `测试连接带回 WebAPI 版本 → ${t.versions.api}`)
    check(String(t.detail).includes('WebAPI'), `设置页那一行能直接显示两个版本 → ${t.detail}`)
  } else {
    check(settingsTest.res.status === 200, `测试连接有结构化应答（未配置/不通时也给原因）→ ${t?.reason || 'ok'}`)
  }

  console.log(failed ? `\n✗ 失败 ${failed} 项` : '\n✓ 全部通过')
  process.exitCode = failed ? 1 : 0
} catch (err) {
  console.error('\n✗ 验收中断：', err.message)
  console.error(logs.join('').slice(-1500))
  process.exitCode = 1
} finally {
  child.kill()
}
