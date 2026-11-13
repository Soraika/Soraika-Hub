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
  episodesOf,
  extensionOf,
  kindOf,
  mikanIdOf,
  missingEpisodesOf,
  renameTargetOf,
  seasonIndexOf,
  sizeText,
  splitSavePath,
  stateTextOf,
  subgroupOf,
} from '../src/lib/downloads.js'
import { metaFromTags, metaOfText, metaTagsOf, releaseMetaTags } from '../src/lib/release-tags.js'

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

/* 缺哪集：断号是真缺（列集号），尾部只是还没下（说「后 N 集未下」） */
check(episodesOf('04').join() === '4' && episodesOf('01-03').join() === '1,2,3', '集号 → 集数集合（合集按区间展开）')
check(episodesOf('').length === 0 && episodesOf('特典').length === 0, '认不出集号 → 空集合（不瞎算）')
const gap = missingEpisodesOf(['01', '03-05'], 6)
check(gap.have === 4 && gap.missing.join() === '2' && gap.tail === 1, `下了 01 03-05 / 共 6 → 缺 ${gap.missing.join()}、后 ${gap.tail} 集未下`)
const partial = missingEpisodesOf(['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'], 25)
check(partial.have === 12 && partial.missing.length === 0 && partial.tail === 13, '下了 01-12 / 共 25 → 不缺（只写「后 13 集未下」）')
check(missingEpisodesOf(['01-12'], 12).missing.length === 0 && missingEpisodesOf(['01-12'], 12).tail === 0, '整季下完 → 已齐（无断号、无尾部）')
check(missingEpisodesOf([], 0).missing.length === 0, '总集数未知 → 不判缺集（剧场版不该显示「缺 1 集」）')
check(missingEpisodesOf(['01-13'], 12).have === 12, '合集比总集数长 → 多出来的不算错')
check(missingEpisodesOf(['14', '15', '16'], 3).have === 3, '累积集号（S02 的 14~16 对一季 3 话）→ 平移到 1 起，不误报全缺')
check(missingEpisodesOf(['特典'], 12).parsed === 0, '一个集号都解析不出 → parsed=0（卡片不显示「已下 0」）')

/* ── 重命名：任务名（旧方括号格式）+ 文件名（番名 S01E01）────────────────── */
const renameOne = renameTargetOf({
  title: '尼古喵喵',
  mikanId: '3992',
  season: 1,
  episode: '1',
  ext: '.mp4',
  subgroup: '樱桃花字幕组',
  rssId: '1205',
})
check(renameOne.fileName === '尼古喵喵 S01E01.mp4', `文件名 = 中文番名 + 季集号 → ${renameOne.fileName}`)
check(
  renameOne.torrentName === '[3992][尼古喵喵][1][01][1205][樱桃花字幕组]',
  `任务名 = 旧方括号格式 → ${renameOne.torrentName}`,
)
check(renameTargetOf({ title: 'x', episode: '01-12', ext: '.mkv' }).fileName === '', '合集（多文件）不改文件名')
check(
  renameTargetOf({ title: 'x', episode: '01-12', ext: '.mkv' }).torrentName === '[][x][1][01-12][][]',
  '合集仍然改任务名（集号是区间）',
)
check(renameTargetOf({ title: 'x', episode: '01', ext: '' }).fileName === '', '多文件种子（没有扩展名）不改文件名')
check(renameTargetOf({ title: '', episode: '01', ext: '.mkv' }) === null, '没有番名 → 跳过')
check(renameTargetOf({ title: 'a/b:c', episode: '3', ext: 'mkv' }).fileName === 'a b c S01E03.mkv', '文件名里的非法字符被替换')
check(extensionOf('a.MKV') === '.mkv' && extensionOf('SE01') === '', '扩展名：有就转小写，多文件目录给空')

/* ── 加种应答：qB 5.x 对「重复种子」回 HTTP 409 —— 那不是失败（实测）───────── */
const { classifyAddResult } = await import('../src/api/sources/qb.js')
check(classifyAddResult({ status: 200, text: 'Ok.' }).ok === true, 'Ok. = 成功')
const dup = classifyAddResult({ status: 409, text: '' })
check(dup.ok === true && dup.existed === true, 'HTTP 409 = 已在列表里（不报失败）', JSON.stringify(dup))
check(classifyAddResult({ status: 200, text: 'Fails.' }).ok === false, 'Fails. = 真失败')
check(
  classifyAddResult({
    status: 200,
    text: '{"added_torrent_ids":["1533d2692bfdf01f049d5617af2f6caefd6d9229"],"failure_count":0,"pending_count":0,"success_count":1}',
  }).ok === true,
  'qB 5.2 的 JSON 应答（success_count=1）= 成功',
)
check(
  classifyAddResult({ status: 200, text: '{"added_torrent_ids":[],"failure_count":1,"pending_count":0,"success_count":0}' }).ok === false,
  'JSON 应答里 failure_count>0 且没有成功 id = 失败',
)
check(!classifyAddResult({ status: 500, text: { error: 'boom' } }).reason.includes('[object'), '错误文案不会出现 [object Object]')
check(classifyAddResult({ status: 0, text: '' }).reason.includes('没有应答'), '空应答也有可读文案（不是 undefined）')
check(classifyAddResult({ status: 409, text: '' }).reason.length > 0, '「已存在」也带一句人能看懂的说明')

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

/* ── 画质/字幕/片源：加种时写进 qB 标签，改名也不丢 ────────────────────── */
const meta1 = metaOfText('[Nekomoe kissaten][Kimi ga Shinu made Koi wo Shitai][12][1080p][JPSC].mp4')
check(meta1.res === '1080P' && meta1.sub === 'JPSC', `从发布名摘画质/字幕 → ${JSON.stringify(meta1)}`)
const meta2 = metaOfText('[Nekomoe kissaten&Airota][Yuru Camp][01-12END][1920x1080][x264_AAC][CHS]')
check(meta2.res === '1080P' && meta2.sub === 'CHS', `宽高写法也认（1920x1080）→ ${JSON.stringify(meta2)}`)
const meta3 = metaOfText('[ANi] 從後面來的神威先生 [年齡限制版] - 10 [1080P][Baha][WEB-DL][AAC AVC][CHT]')
check(meta3.res === '1080P' && meta3.sub === 'CHT' && meta3.src === 'WEB-DL', `片源也摘 → ${JSON.stringify(meta3)}`)
const meta4 = metaOfText('相反的你和我 S02E23.mp4')
check(!meta4.res && !meta4.sub && !meta4.src, '认不出就全空（改名后的文件确实什么都没有）')

const metaTags = metaTagsOf({ res: '1080P', sub: 'JPSC', src: '' })
check(
  metaTags.join(',') === 'res:1080P,sub:JPSC',
  `元数据 → qB 标签（空值不写）→ ${metaTags.join(',')}`,
)
const back = metaFromTags(['soraika', 'mid:4009', 'sg:喵萌奶茶屋', 'res:2160P', 'sub:简繁'])
check(back.res === '2160P' && back.sub === '简繁' && back.src === '', `从标签读回来 → ${JSON.stringify(back)}`)
check(
  releaseMetaTags({ res: '1080P' }, '[X][Y][12][720p]', 3)[0] === '1080P',
  '标签优先于名字（改名之后以标签为准）',
)
check(
  releaseMetaTags({}, '[X][Y][12][720p][CHS]', 3).join(',') === '720P,CHS',
  `老种子没有标签 → 名字兜底 → ${releaseMetaTags({}, '[X][Y][12][720p][CHS]', 3).join(',')}`,
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
    check(Boolean(v.app && v.api), `两个版本都回（应用 ${v.app} / WebAPI ${v.api}）`)
    check(/^v?\d+\.\d+/.test(v.app), `应用版本是版本号形状 → ${v.app}`)

    /* 真重复加种：拿一个已在列表里的磁力再加一次。
       既验证「409 = 已存在」，也验证**加种地址正确**（曾经漏传 apiUrl，请求打到
       `http://host/<apiKey>` 上，qB 回 404 Not Found —— 用户看到的就是这个）。 */
    const { loadStoredSettings } = await import('../src/api/pages/settings.js')
    loadStoredSettings()
    const { qbTorrents, qbAddTorrent } = await import('../src/api/sources/qb.js')
    const { config } = await import('../src/config.js')
    const torrents = await qbTorrents({ fresh: true })
    const withMagnet = torrents.find((t) => String(t.magnet_uri || '').startsWith('magnet:'))
    if (withMagnet) {
      const again = await qbAddTorrent({
        url: withMagnet.magnet_uri,
        savePath: config.qb.saveRoot,
        tags: 'soraika-verify',
        category: config.qb.category,
      })
      check(
        again.ok === true && again.existed === true,
        `重复加种 → 回报「已存在」（顺带验证加种走的是 /api/v2/torrents/add）→ ${String(withMagnet.name).slice(0, 28)}`,
      )
    } else {
      console.log('· 没有带磁力的种子 → 跳过「重复加种」')
    }
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

    /* ── 面板：一部番一份**扁平清单** + 字幕组筛选条 ──────────────────── */
    const sample = items[0]
    const one = await get(`/api/downloads/${sample.id}`)
    const a = one.body?.data || {}
    check(one.res.status === 200 && a.animeId === sample.id, `GET /api/downloads/${sample.id} → 200 且是同一部`)
    check(Array.isArray(a.items) && a.items.length > 0, `扁平清单非空 → ${a.items?.length} 条（不按组分区）`)
    check(Array.isArray(a.groups) && a.groups.length > 0, `筛选条数据 → ${a.groups?.length} 个组`)
    check(
      a.groups.every((g) => typeof g.name === 'string' && g.count > 0),
      '每个组带 name / count（顶部 chip 直接画）',
    )
    const item = a.items?.[0] || {}
    const itemFields = ['hash', 'name', 'fileName', 'episode', 'subgroup', 'tags', 'sizeText', 'stateText']
    check(itemFields.every((k) => k in item), `条目字段齐全（${itemFields.length} 个，含 subgroup / tags）`)
    check(
      a.items.every((it) => it.subgroup && it.subgroup.length > 0),
      '每行都带字幕组（右侧那行小字；认不出统一成「未标注字幕组」）',
    )
    check(Array.isArray(item.tags) && item.tags.length <= 3, `画质/字幕标签是数组且 ≤ 3 个 → ${JSON.stringify(item.tags)}`)
    check(
      a.items.every((it, i, arr) => i === 0 || episodeOrder(arr[i - 1].episode) >= episodeOrder(it.episode)),
      '整份清单按集号倒序（最新的在最上面）',
    )
    // 组计数要和清单自洽（筛选条上的数字必须等于筛出来的条数）
    const counts = new Map()
    for (const it of a.items) counts.set(it.subgroup, (counts.get(it.subgroup) || 0) + 1)
    check(
      a.groups.every((g) => counts.get(g.name) === g.count),
      '筛选条的组计数与清单里的实际条数一致',
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

  /* 重命名：校验与默认 dryRun（不传 dryRun 时只返回计划，不写 qB） */
  const badRename = await post('/api/downloads/rename', { animeId: 'abc' })
  check(badRename.res.status === 400, '重命名：animeId 非法 → 400 / BAD_REQUEST')
  const missingRename = await post('/api/downloads/rename', { animeId: 99999999 })
  check(missingRename.res.status === 404 && missingRename.body?.error?.code === 'NOT_FOUND', '重命名：不存在的作品 → 404')

  /* 自动重命名队列：默认 dry-run（只给计划，不写 qB） */
  const allDry = await post('/api/downloads/rename-all', { limit: 3 })
  check(
    allDry.res.ok && allDry.body?.data?.dryRun === true && Array.isArray(allDry.body.data.plan),
    '重命名队列：dry-run 返回计划（默认不写 qB）',
  )
  check(Number.isInteger(allDry.body?.data?.skippedCount), '重命名队列：给出跳过计数（合集 / 多文件 / 已符合）')

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
