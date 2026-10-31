/**
 * 面板 / 下载页「真挂 DOM」冒烟 —— SSR 测不出的那一层
 * ---------------------------------------------------------------------------
 * 为什么必须有它：`verify-e2e` 用 SSR 渲染，面板关闭、列表为空、`v-if` 分支全不执行，
 * 曾经因此漏过两次**渲染期异常**（面板一渲染就抛错 → 界面永远停在上一帧的加载态）：
 *   ① `SeasonPicker` 里 `seasons is not defined`（弹层永远不出现）
 *   ② `DownloadList` 里 `isBatch is not a function`（「已下载」永远显示「正在读下载记录…」）
 *
 * 做法（与 `verify-picker.mjs` 同一套）：vite 打一个只挂组件的 harness → happy-dom 里 import
 * → 等它把数据渲染出来 → 断言 DOM。**接口全部用固定数据打桩**，不依赖后端 / qB / 外网，
 * 所以在任何机器上跑都是同一个结果。
 *
 * 覆盖：面板 × 两种数据源（Mikan 资源 / 已下载文件）+ 下载页卡片墙。
 */
import { build } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'node:path'
import fs from 'node:fs'
import { Window } from 'happy-dom'

const root = process.cwd()
const harness = path.resolve(root, 'scripts/panel-harness')
const dist = path.resolve(root, 'scripts/.panel-dist')
const failures = []
const check = (ok, label, extra = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${extra ? ` → ${extra}` : ''}`)
  if (!ok) failures.push(label)
}

/* ── 打桩数据（形状与后端 DTO 完全一致，见 Server/src/api/pages/*.js）──────── */

const DETAIL = {
  id: 417,
  title: '相反的你和我 第二季',
  titleOriginal: '正反対な君と僕',
  poster: '',
  score: 8,
  scoreText: '8.0',
  ratingText: '4839人评分',
  watchingText: '3436人在看',
  epsText: '13 话',
  seasonText: '2026 夏',
  weekdayText: '周日',
  airDate: '2026-07-05',
  tags: ['校园', '恋爱'],
  summary: '两个性格截然不同的人，彼此尊重、慢慢加深理解的爱情喜剧。',
  bgmId: '400000',
  mikanId: '4037',
  bgmUrl: 'https://bgm.tv/subject/400000',
  mikanUrl: 'https://mikanime.tv/Home/Bangumi/4037',
}

/** Mikan 资源（面板第一级 / 第二级） */
const SUBGROUPS = [
  { id: 1205, name: '樱桃花字幕组', mikanId: '900', rssId: '1205' },
  { id: 34, name: '极影字幕社', mikanId: '12', rssId: '34' },
]
const RELEASES = [
  {
    title: '[樱桃花字幕组]正相反的你和我 - 25 [1080p][简日内嵌]',
    magnet: 'magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    magnetHash: 'a'.repeat(40),
    torrentUrl: 'https://mikanime.tv/Download/1.torrent',
    sizeText: '204.2 MB',
    publishedText: '11-01 00:02',
    subgroup: '樱桃花字幕组',
  },
  {
    title: '[樱桃花字幕组]正相反的你和我 - 24 [1080p][简日内嵌]',
    magnet: 'magnet:?xt=urn:btih:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    magnetHash: 'b'.repeat(40),
    torrentUrl: 'https://mikanime.tv/Download/2.torrent',
    sizeText: '201.4 MB',
    publishedText: '10-25 00:01',
    subgroup: '樱桃花字幕组',
  },
]

/** 已下载（qB）—— 注意合集条目 `01-12`：渲染时要用 isBatchEpisode 判定 */
const DL_ITEMS = [
  {
    hash: 'c'.repeat(40),
    name: '[4037][相反的你和我 第二季][2][23][1205][樱桃花字幕组]',
    fileName: '相反的你和我 S02E23.mp4',
    episode: '23',
    season: 2,
    kind: 'done',
    state: 'stoppedUP',
    stateText: '已完成',
    progress: 100,
    sizeText: '209 MB',
    savePath: '/downloads/anime/相反的你和我/SE02',
    contentPath: '/downloads/anime/相反的你和我/SE02/相反的你和我 S02E23.mp4',
    addedAt: 1788000000,
    completedAt: 1788100000,
  },
  {
    hash: 'd'.repeat(40),
    name: '[1505][摇曳露营][1][1-12][422][喵萌奶茶屋]',
    fileName: '[Nekomoe][Yuru Camp][01-12END][1080p]',
    episode: '01-12',
    season: 1,
    kind: 'downloading',
    state: 'stalledDL',
    stateText: '下载中（无进度）',
    progress: 94,
    sizeText: '2.8 GB',
    savePath: '/downloads/anime/摇曳露营/SE01',
    contentPath: '/downloads/anime/摇曳露营/SE01/[Nekomoe][Yuru Camp][01-12END][1080p]',
    addedAt: 1788100000,
    completedAt: -1,
  },
]
const DL_ANIME = {
  animeId: DETAIL.id,
  title: DETAIL.title,
  total: DL_ITEMS.length,
  sizeText: '3.0 GB',
  subgroups: [
    { id: '樱桃花字幕组', name: '樱桃花字幕组', count: 1, sizeText: '209 MB', items: [DL_ITEMS[0]] },
    { id: '喵萌奶茶屋', name: '喵萌奶茶屋', count: 1, sizeText: '2.8 GB', items: [DL_ITEMS[1]] },
  ],
}


/** 下载页卡片墙 */
const DL_LIST = {
  configured: true,
  versions: { app: 'v5.2.1', api: '2.15.1' },
  transfer: { status: 'connected', dlSpeed: 0, upSpeed: 0 },
  counts: { total: 2, downloading: 1, done: 1, missing: 0, anime: 2, sizeBytes: 3.2e9, sizeText: '3.0 GB' },
  items: [
    {
      id: 417,
      animeId: 417,
      title: '相反的你和我 第二季',
      poster: '',
      count: 1,
      doneCount: 1,
      downloadingCount: 0,
      missingCount: 0,
      latestEpisode: 23,
      totalEpisodes: 13,
      episodes: ['23'],
      seasons: [2],
      season: 2,
      sizeBytes: 209e6,
      sizeText: '209 MB',
      state: 'done',
      stateText: '已完成',
      progress: 100,
      speedText: '',
    },
    {
      id: 6031,
      animeId: 6031,
      title: '摇曳露营△',
      poster: '',
      count: 1,
      doneCount: 0,
      downloadingCount: 1,
      missingCount: 0,
      latestEpisode: 12,
      totalEpisodes: 12,
      episodes: ['01-12'],
      seasons: [1],
      season: 1,
      sizeBytes: 3e9,
      sizeText: '2.8 GB',
      state: 'downloading',
      stateText: '下载中',
      progress: 94,
      speedText: '',
    },
  ],
  unmatched: [{ name: '某个认不出的目录', count: 1, sizeText: '700 MB', stateText: '已完成' }],
}

const json = (data) => ({ ok: true, body: { ok: true, data } })
function route(url) {
  const u = new URL(url, 'http://127.0.0.1:3100')
  const p = u.pathname
  if (p === '/api/downloads') return json(DL_LIST)
  if (p.startsWith('/api/downloads/')) return json(DL_ANIME)
  if (p === '/api/qb/status') return json({ configured: true, versions: DL_LIST.versions, transfer: DL_LIST.transfer })
  if (/^\/api\/anime\/\d+\/series$/.test(p)) return json(null)
  if (/^\/api\/anime\/\d+\/subgroups$/.test(p)) return json({ items: SUBGROUPS, source: 'mikan' })
  if (/^\/api\/anime\/\d+\/releases/.test(p)) {
    return json({ subgroup: { id: 1205, name: '樱桃花字幕组' }, items: RELEASES, total: RELEASES.length, cached: false })
  }
  if (/^\/api\/anime\/\d+$/.test(p)) return json(DETAIL)
  // AI 一律当「没配置」：面板要走的就是这条降级路径（不花 token、也不该崩）
  if (p.startsWith('/api/ai/')) {
    return { ok: false, body: { ok: false, error: { code: 'AI_DISABLED', message: '未配置 AI' } } }
  }
  return { ok: false, body: { ok: false, error: { code: 'NOT_FOUND', message: `stub 没有 ${p}` } } }
}


/* ── 构建 harness ─────────────────────────────────────────────────────── */
async function buildEntry(entry) {
  const outDir = path.join(dist, entry)
  await build({
    root: harness,
    logLevel: 'error',
    plugins: [vue()],
    resolve: { alias: { '@': path.resolve(root, 'src') } },
    build: { outDir, emptyOutDir: true, rollupOptions: { input: path.join(harness, `${entry}.html`) } },
  })
  const assets = fs.readdirSync(path.join(outDir, 'assets'))
  return path.join(outDir, 'assets', assets.find((f) => f.endsWith('.js')))
}

/* ── 在 happy-dom 里挂一次 ─────────────────────────────────────────────── */
async function mountPage(jsPath, url, waitMs) {
  const win = new Window({ url })
  globalThis.window = win
  globalThis.document = win.document
  Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true })
  globalThis.HTMLElement = win.HTMLElement
  globalThis.Element = win.Element
  globalThis.Node = win.Node
  globalThis.SVGElement = win.SVGElement
  globalThis.getComputedStyle = win.getComputedStyle.bind(win)
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16)
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id)

  const errors = []
  const onErr = (err) => errors.push(err?.message || String(err))
  process.on('uncaughtException', onErr)
  process.on('unhandledRejection', onErr)
  // Vue 的渲染异常是**在 effect 里抛出后自己 console.error** 的，不接住就等于没测
  const originalWarn = console.warn
  const originalError = console.error
  console.warn = (...args) => errors.push(String(args[0]))
  console.error = (...args) => errors.push(String(args[0]))

  globalThis.fetch = async (input) => {
    // 前端传的是 `new URL()`（api/http.js），字符串 / Request 也兼容
    const target = typeof input === 'string' ? input : input?.href || input?.url || String(input)
    const { ok, body } = route(target)
    if (process.env.VERIFY_PANEL_DEBUG) console.log('    [stub]', target, ok ? 'ok' : 'fail')
    return {
      ok,
      status: ok ? 200 : 501,
      headers: { get: () => 'application/json' },
      json: async () => body,
      text: async () => JSON.stringify(body),
    }
  }

  document.body.innerHTML = '<div id="app"></div>'
  await import(new URL(`file://${jsPath.replace(/\\/g, '/')}`).href)
  await new Promise((r) => setTimeout(r, waitMs))

  process.off('uncaughtException', onErr)
  process.off('unhandledRejection', onErr)
  console.warn = originalWarn
  console.error = originalError
  return { win, text: (document.body.textContent || '').replace(/\s+/g, ' '), errors }
}

/** 只关心真异常：`Failed to resolve component` 这类是打桩环境的噪音 */
const realErrors = (errors) =>
  errors.filter((e) => !/Failed to resolve component|Extraneous non-props|stub 没有|AI_DISABLED/.test(e))

console.log('— 面板：已下载模式（source=downloads）')
{
  const js = await buildEntry('index')
  const { win, text, errors } = await mountPage(js, 'http://127.0.0.1:3100/?source=downloads', 400)
  check(!realErrors(errors).length, '渲染期没有异常', realErrors(errors)[0] || 'ok')
  check(text.includes('樱桃花字幕组'), '字幕组选择条渲染出来了')
  check(!text.includes('正在读下载记录'), '「已下载」不是加载态', text.includes('正在读下载记录') ? '卡在加载 ✗' : 'ok')

  /* 一条只留三件事：集数 / 这集是什么货 / 异常状态；文件名进 title、路径不显示 */
  check(text.includes('209 MB'), '体积渲染出来了')
  check(!text.includes('已完成'), '正常条目不再逐条写「已完成」（那是整块的默认状态）')
  check(!text.includes('/downloads/anime'), '保存路径不再显示（排错信息不进面板）')
  const firstItem = document.querySelector('.dl-list .item')
  check(
    (firstItem?.getAttribute('title') || '').includes('相反的你和我 S02E23.mp4'),
    '完整文件名挂在整行 title 上（hover 可见）',
    firstItem?.getAttribute('title') || '（没有 title）',
  )
  check(Boolean(firstItem?.querySelector('.ep')), '集数区在（首页同款竖条）')

  /* 切到第二个组：合集条目（`01-12`）+ 画质标签 + 下载中状态 */
  const chip = [...document.querySelectorAll('.subgroups .chip')].find((b) => b.textContent.includes('喵萌奶茶屋'))
  chip?.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 150))
  const after = (document.body.textContent || '').replace(/\s+/g, ' ')
  check(Boolean(chip), '能点第二个字幕组（切组是内存操作）')
  check(after.includes('01-12'), '合集条目也渲染出来了（isBatchEpisode 生效）')
  check(after.includes('1080P'), '画质标签从文件名里摘出来了')
  check(after.includes('下载中（无进度）') && after.includes('94%'), '下载中给状态 + 进度')
  check(!realErrors(errors).length, '切组没有渲染期异常', realErrors(errors)[0] || 'ok')
}

console.log('\n— 面板：Mikan 资源模式（source=mikan）')
{
  const js = await buildEntry('index')
  const { text, errors } = await mountPage(js, 'http://127.0.0.1:3100/?source=mikan', 400)
  check(!realErrors(errors).length, '渲染期没有异常', realErrors(errors)[0] || 'ok')
  check(!text.includes('正在取资源列表'), '资源列表不是加载态', text.includes('正在取资源列表') ? '卡在加载 ✗' : 'ok')
  check(text.includes('正相反的你和我 - 25'), '资源条目渲染出来了')
  check(text.includes('全部下载 (2)'), '批量下载入口渲染出来了')
  check(!text.includes('已下载'), 'Mikan 模式不出现「已下载」块')
}

console.log('\n— 下载页：卡片墙')
{
  const js = await buildEntry('page')
  const { text, errors } = await mountPage(js, 'http://127.0.0.1:3100/', 400)
  check(!realErrors(errors).length, '渲染期没有异常', realErrors(errors)[0] || 'ok')
  check(!text.includes('正在读下载记录'), '不在加载态', text.includes('正在读下载记录') ? '卡在加载 ✗' : 'ok')
  check(text.includes('下载中') && text.includes('已完成'), '按状态分区渲染出来了')
  check(text.includes('qB v5.2.1 · WebAPI 2.15.1'), '顶部显示两个版本')
  check(text.includes('未识别'), '「未识别」那一栏也在（不藏起来）')
}

fs.rmSync(dist, { recursive: true, force: true })
console.log(failures.length ? `\n✗ 失败 ${failures.length} 项` : '\n✓ 全部通过')
process.exit(failures.length ? 1 : 0)
