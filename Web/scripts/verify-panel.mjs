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
    subgroup: '樱桃花字幕组',
    tags: ['1080P', '简日内嵌'],
    kind: 'done',
    state: 'stoppedUP',
    stateText: '已完成',
    progress: 100,
    sizeText: '209 MB',
    sizeBytes: 209e6,
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
    subgroup: '喵萌奶茶屋',
    tags: ['1080P'],
    kind: 'downloading',
    state: 'stalledDL',
    stateText: '下载中（无进度）',
    progress: 94,
    sizeText: '2.8 GB',
    sizeBytes: 3e9,
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
  groups: [
    { name: '樱桃花字幕组', count: 1, sizeText: '209 MB' },
    { name: '喵萌奶茶屋', count: 1, sizeText: '2.8 GB' },
  ],
  /** 扁平清单：默认全显示（不按组分区），组名是每行的附注 */
  items: DL_ITEMS,
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

/** 提示词接口（设置页用）：bundle 有系统段改动 + 自定义补充，其余用默认 */
const PROMPT_TEXT = {
  bundle: '你是动漫资源文件名解析专家。只返回 JSON：{ "tags": [{ "display": "", "match": [] }], "episodes": {} }',
  series: '你在给一个动画系列做归档命名。输出 { "namingStyle": "", "rootTitle": "", "extras": [] }',
  format: '你在看一批来自同一个字幕组的资源文件名。输出 { "prefix": "", "literals": [] }',
  groupTags: '把组标记对应到库里的组名（只能从下面的列表里选）。{{NAMES}}',
}
const PROMPTS = {
  source: 'override',
  keys: ['bundle', 'series', 'format', 'groupTags'],
  customized: ['bundle'],
  prompts: Object.fromEntries(
    Object.entries(PROMPT_TEXT).map(([key, system]) => {
      const custom = key === 'bundle' ? '优先保留 1080P。' : ''
      return [
        key,
        {
          version: 'v10',
          hash: `hash-${key}`,
          system,
          custom,
          effective: custom ? `${system}\n\n【用户补充要求】\n${custom}` : system,
        },
      ]
    }),
  ),
  defaults: { ...PROMPT_TEXT },
}

const json = (data) => ({ ok: true, body: { ok: true, data } })
function route(url) {
  const u = new URL(url, 'http://127.0.0.1:3100')
  const p = u.pathname
  if (p === '/api/downloads') return json(DL_LIST)
  if (p.startsWith('/api/downloads/')) return json(DL_ANIME)
  if (p === '/api/qb/status') return json({ configured: true, versions: DL_LIST.versions, transfer: DL_LIST.transfer })
  /* 提示词：四段 + 出厂默认 + 已改段（设置页只读卡片用） */
  if (p === '/api/ai/prompts') return json(PROMPTS)
  if (/^\/api\/anime\/\d+\/series$/.test(p)) return json(null)
  if (/^\/api\/anime\/\d+\/subgroups$/.test(p)) return json({ items: SUBGROUPS, source: 'mikan' })
  if (/^\/api\/anime\/\d+\/releases/.test(p)) {
    return json({ subgroup: { id: 1205, name: '樱桃花字幕组' }, items: RELEASES, total: RELEASES.length, cached: false })
  }
  if (/^\/api\/anime\/\d+$/.test(p)) return json(DETAIL)
  // 其余 AI 一律当「没配置」：面板要走的就是这条降级路径（不花 token、也不该崩）
  if (p.startsWith('/api/ai/')) {
    return { ok: false, body: { ok: false, error: { code: 'AI_DISABLED', message: '未配置 AI' } } }
  }
  return { ok: false, body: { ok: false, error: { code: 'NOT_FOUND', message: `stub 没有 ${p}` } } }
}


/* ── 构建 harness（每次给一个**唯一文件名**：ESM 按 URL 缓存，同名就只执行一次）── */
let buildSeq = 0
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
  const src = path.join(outDir, 'assets', assets.find((f) => f.endsWith('.js')))
  const unique = path.join(outDir, `run-${++buildSeq}-${path.basename(src)}`)
  fs.copyFileSync(src, unique)
  return unique
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
  /*
   * happy-dom 的类内部会直接引用浏览器全局（Document / ShadowRoot / HTMLTextAreaElement…），
   * 在 Node 里它们只挂在 window 上。少一个就会在 v-model 更新输入框时抛 ReferenceError。
   * 这里只补**确实会被 instanceof 用到的**那几个 —— 不要遍历 window 全量搬运：
   * 那样会顺带触发一堆 lazy getter，反而把事件系统搞坏（实测点击/输入都不再触发）。
   */
  for (const key of [
    'Document',
    'DocumentFragment',
    'ShadowRoot',
    'Event',
    'CustomEvent',
    'MouseEvent',
    'KeyboardEvent',
    'HTMLInputElement',
    'HTMLTextAreaElement',
    'HTMLSelectElement',
    'HTMLButtonElement',
    'HTMLAnchorElement',
    'Text',
    'Comment',
    'CSSStyleDeclaration',
  ]) {
    if (!(key in globalThis) && typeof win[key] === 'function') globalThis[key] = win[key]
  }
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

  /* 一条只留三件事：集数 / 这集是什么货 /（右侧）字幕组；文件名进 title、路径不显示 */
  check(text.includes('209 MB') && text.includes('2.8 GB'), '两个组的条目**同时**铺在一层（不按组分区）')
  check(!text.includes('已完成'), '正常条目不再逐条写「已完成」（那是整块的默认状态）')
  check(!text.includes('/downloads/anime'), '保存路径不再显示（排错信息不进面板）')
  const rows = [...document.querySelectorAll('.dl-list .item')]
  check(rows.length === 2, `一次就把全部条目列出来 → ${rows.length} 条`)
  check(
    rows.every((r) => Boolean(r.querySelector('.subgroup')?.textContent?.trim())),
    '每行**右侧**都标了字幕组',
    rows.map((r) => r.querySelector('.subgroup')?.textContent?.trim()).join(' / '),
  )
  check(
    (rows[0]?.getAttribute('title') || '').includes('相反的你和我 S02E23.mp4'),
    '完整文件名挂在整行 title 上（hover 可见）',
    rows[0]?.getAttribute('title') || '（没有 title）',
  )
  check(Boolean(rows[0]?.querySelector('.ep')), '集数区在（首页同款竖条）')

  /* 顶部 chip 在下载页模式是**筛选**：点某一个组 → 只剩该组 */
  const chip = [...document.querySelectorAll('.subgroups .chip')].find((b) => b.textContent.includes('樱桃花字幕组'))
  check(Boolean(chip), '筛选条里出现「全部」+ 各组')
  chip?.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 150))
  const filtered = [...document.querySelectorAll('.dl-list .item')]
  check(filtered.length === 1, `点某个组 → 只剩该组的条目 → ${filtered.length} 条`)
  const afterText = (document.body.textContent || '').replace(/\s+/g, ' ')
  check(afterText.includes('1080P'), '画质标签渲染出来了')
  check(!realErrors(errors).length, '筛选没有渲染期异常', realErrors(errors)[0] || 'ok')
}

console.log('\n— 面板：已下载（单组时不显示筛选条）')
{
  /* 只有一个组时「全部 + 1」筛了等于没筛，那条 chip 栏应该藏起来 */
  DL_ANIME.groups = [{ name: '樱桃花字幕组', count: 2, sizeText: '3.0 GB' }]
  DL_ITEMS.forEach((it) => (it.subgroup = '樱桃花字幕组'))
  const js = await buildEntry('index')
  const { text, errors } = await mountPage(js, 'http://127.0.0.1:3100/?source=downloads', 400)
  check(!realErrors(errors).length, '渲染期没有异常', realErrors(errors)[0] || 'ok')
  check(!document.querySelector('.subgroups'), '单组时筛选条整块不出现')
  check(text.includes('01-12') && text.includes('下载中（无进度）') && text.includes('94%'), '合集条目 + 下载中状态都在')
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
  check(text.includes('自动刷新中'), '有下载中的任务 → 显示「自动刷新中」（页面自己在更新）')
  if (process.env.VERIFY_PANEL_DEBUG) console.log('  [debug] 页面文本 =', text.slice(0, 160))
}

console.log('\n— 设置页：提示词（系统段 + 用户补充）')
{
  const js = await buildEntry('prompts')
  const { win, text, errors } = await mountPage(js, 'http://127.0.0.1:3100/', 400)
  check(!realErrors(errors).length, '渲染期没有异常', realErrors(errors)[0] || 'ok')
  check(!text.includes('正在读提示词'), '不在加载态', text.includes('正在读提示词') ? '卡在加载 ✗' : 'ok')
  check(
    ['标签 + 集数', '系列归一', '格式特征', '组标记 → 组名'].every((t) => text.includes(t)),
    '四个页签都在',
  )
  check(text.includes('有改动（用着你的版本）'), '顶部胶囊显示「有改动」（source=override）')
  check(text.includes('系统提示词') && text.includes('用户补充'), '两段都有标题（系统提示词 / 用户补充）')
  check(document.querySelectorAll('textarea').length === 2, '两段各一个输入框（都能改）')
  check(
    document.querySelector('textarea')?.value?.includes('"tags"'),
    '系统段输入框里是带 JSON 结构的那段（真正的契约）',
  )
  check(text.includes('保存提示词'), '有保存按钮（没有改动时文案是「保存提示词」）')
  check(text.includes('恢复这一段默认') && text.includes('全部恢复默认'), '有恢复默认的入口')

  /* 改补充段 → 该页签出现未保存标记、按钮变成「保存 1 段」 */
  const customBox = document.querySelectorAll('textarea')[1]
  customBox.value = '优先保留 2160P。'
  customBox.dispatchEvent(new win.Event('input', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 120))
  const afterEdit = (document.body.textContent || '').replace(/\s+/g, ' ')
  check(afterEdit.includes('保存 1 段'), '改过之后保存按钮显示「保存 1 段」')
  check(Boolean(document.querySelector('.tab-dot')), '改过的页签带未保存圆点')
  check(!realErrors(errors).length, '编辑没有渲染期异常', realErrors(errors)[0] || 'ok')

  /* 切页签：输入框里换成那一段的内容（textarea 的 value 不进 textContent） */
  const seriesTab = [...document.querySelectorAll('.prompt-tab')].find((b) => b.textContent.includes('系列归一'))
  seriesTab?.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 120))
  const systemValue = String(document.querySelectorAll('textarea')[0]?.value || '')
  check(systemValue.includes('namingStyle'), '点「系列归一」后输入框换成对应那段提示词')
  check(!realErrors(errors).length, '切页签没有渲染期异常', realErrors(errors)[0] || 'ok')
}

fs.rmSync(dist, { recursive: true, force: true })
console.log(failures.length ? `\n✗ 失败 ${failures.length} 项` : '\n✓ 全部通过')
process.exit(failures.length ? 1 : 0)
