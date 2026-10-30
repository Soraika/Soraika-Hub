/**
 * 端到端验收 —— 后端 + vite 代理 + 首页与侧边详情面板
 * ---------------------------------------------------------------------------
 * 用法：`npm run verify:e2e`
 * 自带环境：脚本自己起一个**隔离后端**（:3390）与一个 vite dev（:5174，代理指向它），
 *   所以不依赖开发实例是否在跑，也不受它内存缓存的影响（与后端 verify-* 同思路）。
 * 覆盖三件事：
 *   ① vite 的 /api 代理通（前端只写相对路径、同源）
 *   ② 首页真数据渲染：卡片 / 海报出图入口 / 季选 / 7 个星期区块 / 三态
 *   ③ 点海报后的侧边面板：详情渲染 + loading / error 态 + 面板开关逻辑（useAnimeDetail）
 * 任一项失败 → 非 0 退出。
 */
import { spawn } from 'node:child_process'
import { parseDuration, unitForMs, toDisplayText, toMilliseconds } from '../src/utils/duration.js'
import { once } from 'node:events'
import { readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { createSSRApp, h } from 'vue'
import { createServer } from 'vite'
import { renderToString } from 'vue/server-renderer'

const API_PORT = 3390
const DEV = 'http://127.0.0.1:5174'

let failed = 0
const check = (ok, msg) => {
  if (!ok) failed++
  console.log(`${ok ? '✓' : '✗'} ${msg}`)
}

const isUp = async (url) => {
  try {
    return (await fetch(url)).ok
  } catch {
    return false
  }
}

// api/http.js 用 window.location.origin 拼相对地址 —— Node 里没有 window，
// 给个最小替身指向 vite dev，这样前端请求会真的走一遍代理（验收这一点本身）
globalThis.window = { location: { origin: DEV } }

/* ── ① 隔离后端（**独立库文件**：验收会写设置，绝不能拿 data/hub.db 试） ─ */
const DB_FILE = 'data/tmp-verify-e2e.db'
const api = spawn(process.execPath, ['--env-file-if-exists=.env', 'src/index.js'], {
  cwd: resolve('..', 'Server'),
  env: { ...process.env, PORT: String(API_PORT), DB_FILE },
  stdio: ['ignore', 'ignore', 'ignore'],
})

let vite
try {
  for (let i = 0; i < 80 && !(await isUp(`http://127.0.0.1:${API_PORT}/api/health`)); i++) {
    await new Promise((r) => setTimeout(r, 250))
  }
  check(await isUp(`http://127.0.0.1:${API_PORT}/api/health`), `隔离后端已在 :${API_PORT} 起来`)

  /* ── ② vite dev + /api 代理 ────────────────────────────────────────── */
  process.env.API_TARGET = `http://127.0.0.1:${API_PORT}` // 必须在 createServer 之前：vite.config.js 读它
  vite = await createServer({ server: { host: '127.0.0.1', port: 5174, strictPort: true }, logLevel: 'error' })
  await vite.listen()

  const proxied = await (await fetch(`${DEV}/api/home/schedule`)).json()
  check(proxied?.ok === true && proxied.data.days.length > 0, `vite 代理 /api 通 → ${proxied?.data?.days?.length} 个区块`)

  const items = proxied.data.days.flatMap((d) => d.items)
  const firstItem = items[0]

  /* ── ③ 首页 SSR：真数据 + 三态 ─────────────────────────────────────── */
  const { default: HomePage } = await vite.ssrLoadModule('/src/pages/HomePage.vue')
  const baseProps = {
    days: proxied.data.days,
    years: proxied.data.years,
    season: proxied.data.season,
    uiState: 'ready',
  }
  const home = await renderToString(createSSRApp({ render: () => h(HomePage, baseProps) }))

  check(home.includes('day-section'), '渲染出排期区块')
  check(home.includes(firstItem.title), `真数据卡片进了 DOM → 「${firstItem.title}」`)
  /* 海报地址有两种（都合法）：① 本地已缓存 / 连图源都没有 → 统一出图入口 `/api/img/anime/{id}`；
     ② 有图源但本地还没缓存 → **图源直链**（浏览器先直接显示，后端同时预热存本地）。
     所以这里验的是「后端给的那个地址确实进了 DOM」，而不是钉死某一种形态。 */
  check(
    (firstItem.poster || '').length > 0 && home.includes(firstItem.poster),
    `海报地址来自后端并进了 DOM → ${String(firstItem.poster).slice(0, 64)}`,
  )
  check(home.includes(proxied.data.season.label), `季选显示后端下发的季 → ${proxied.data.season.label}`)
  for (const label of ['周日', '周一', '周二', '周三', '周四', '周五', '周六']) {
    check(home.includes(label), `${label} 区块在（地铁 7 站都有落点）`)
  }
  // 评分要等后台补齐（隔离库刚建好时可能还没补到）——有就断，没有就跳过并说明
  const scored = items.filter((i) => i.score != null)
  if (scored.length) {
    check(home.includes(scored[0].ratingText), `评分文案由后端成品字符串直出 → ${scored[0].ratingText}`)
  } else {
    console.log('· 隔离库刚建好、后台还没补到评分 → 跳过「评分文案」这一条')
  }

  const loading = await renderToString(
    createSSRApp({ render: () => h(HomePage, { ...baseProps, days: [], uiState: 'loading' }) }),
  )
  check(loading.includes('正在加载本周排期'), '首页 loading 三态正常')
  const error = await renderToString(
    createSSRApp({ render: () => h(HomePage, { ...baseProps, days: [], uiState: 'error' }) }),
  )
  check(error.includes('加载失败') && error.includes('重试'), '首页 error 三态 + 重试按钮正常')
  const empty = await renderToString(
    createSSRApp({ render: () => h(HomePage, { ...baseProps, days: [], uiState: 'empty' }) }),
  )
  check(empty.includes('本季度暂无排期数据'), '首页 empty 三态正常')

  /* ── ③b 点击接线：海报是可点元素，选中态跟着面板走 ─────────────────── */
  check(/class="[^"]*poster-card[^"]*clickable[^"]*cl"/.test(home.replace(/>/g, '> ')) || home.includes('role="button"'), '海报卡是可点击元素（role=button / clickable）')
  const selectedHome = await renderToString(
    createSSRApp({ render: () => h(HomePage, { ...baseProps, activeAnimeId: firstItem.id }) }),
  )
  check(/class="[^"]*poster-card[^"]*selected[^"]*"/.test(selectedHome), '面板里那部作品的卡片带 selected 选中态')

  /* ── ④ 详情接口（同样经代理）+ 面板 SSR ────────────────────────────── */
  const detailRes = await (await fetch(`${DEV}/api/anime/${firstItem.id}`)).json()
  const detail = detailRes?.data
  check(detailRes?.ok === true && detail?.id === firstItem.id, `代理下的详情接口可用 → ${detail?.title}`)
  check(detail?.score === firstItem.score, `详情评分与卡片一致 → ${detail?.score}`)
  check(
    detail?.scoreText === firstItem.scoreText && (!detail?.score || detail.scoreText === Number(detail.score).toFixed(1)),
    `评分成品字符串一位小数且与卡片一致 → ${detail?.scoreText || '（无）'}`,
  )

  const { default: AnimeDetailPanel } = await vite.ssrLoadModule('/src/components/detail/AnimeDetailPanel.vue')
  const renderPanel = (props) =>
    renderToString(createSSRApp({ render: () => h(AnimeDetailPanel, { visible: true, ...props }) }))

  const panel = await renderPanel({ data: detail, uiState: 'ready' })
  check(panel.includes('class="panel open"'), '面板展开态（.panel.open）渲染出来了')
  check(panel.includes(detail.title), `面板显示番名 → ${detail.title}`)
  check(!detail.seasonText || panel.includes(detail.seasonText), `面板显示放送 → ${detail.seasonText}`)
  check(!detail.epsText || panel.includes(detail.epsText), `面板显示集数 → ${detail.epsText}`)
  check(
    !detail.scoreText || panel.includes(detail.scoreText),
    `面板评分与卡片同一份成品字符串（8 不会显示成「8」）→ ${detail.scoreText || '（无）'}`,
  )
  check(!detail.ratingText || panel.includes(detail.ratingText), `面板显示评分人数 → ${detail.ratingText}`)
  check(!detail.tags.length || panel.includes(detail.tags[0]), `面板显示标签 → ${detail.tags[0] || '（无）'}`)
  check(!detail.bgmUrl || panel.includes(`href="${detail.bgmUrl}"`), `面板外链指向 Bangumi → ${detail.bgmUrl}`)
  check(panel.includes('关闭（Esc）'), '面板有关闭按钮（含 Esc 提示）')

  const panelLoading = await renderPanel({ uiState: 'loading' })
  check(
    panelLoading.includes('skeleton') && panelLoading.includes('sk-poster') && !panelLoading.includes('detail-title'),
    '面板 loading 态 = 骨架屏（结构占位，不是整块转圈、也不残留旧内容）',
  )
  const panelError = await renderPanel({ uiState: 'error', errorText: '读不到这一条' })
  check(panelError.includes('读不到这一条') && panelError.includes('重试'), '面板 error 态：具体文案 + 重试按钮')

  /* ── ④b 换作品的动效：**骨架屏就地替换**（不是整块转圈、也不是整块淡入淡出）
     —— 点海报 → 立刻铺骨架（海报/标题/标签/简介/资源区都占住位）→ 数据到了原处换内容。
     这是 UI 契约：动的是"那些位置"，版面不跳。 ── */
  const panelSource = readFileSync(new URL('../src/components/detail/AnimeDetailPanel.vue', import.meta.url), 'utf8')
  const skeletonSource = readFileSync(new URL('../src/components/detail/DetailSkeleton.vue', import.meta.url), 'utf8')
  check(
    /<DetailSkeleton v-if="uiState === 'loading'" \/>/.test(panelSource) &&
      /<StateBlock\s+v-else-if="uiState === 'error'"/.test(panelSource),
    '换作品时立刻铺骨架屏（loading → DetailSkeleton），不是整块转圈',
  )
  check(
    !panelSource.includes('<Transition name="phase"') && !panelSource.includes('.phase-enter-active'),
    '换作品不再整块淡入淡出（骨架屏就地替换，只有局部位置在动）',
  )
  check(
    skeletonSource.includes('sk-poster') && skeletonSource.includes('sk-sweep') && skeletonSource.includes('sk-card'),
    '骨架屏照着详情的位置铺块（海报 / 标题 / 卡片 / 扫光动效）',
  )

  /* ── 系列 chip（标题区）：一拍即开、点某部就换作品 ────────────────────── */
  check(
    panelSource.includes('class="chip-series"') &&
      panelSource.includes('series.items.length > 1') &&
      panelSource.includes('PopoverPanel') &&
      panelSource.includes("emit('open', item.animeId)"),
    '系列 chip：标题区一拍即开（弹层列同系列），点某部换面板（emit open）',
  )
  /* 弹层**不能**挂在 chip 上：面板内层是 `overflow-x: hidden` 的滚动区，
     绝对定位的弹层从 chip 左沿往右展开时会顶出面板右侧被裁掉（用户反馈"右边被挡住"）。
     正确做法：挂 `.detail-header` 上、left/right 撑满面板内容宽度 → 怎么放都在面板里。 */
  check(
    /\.detail-header\s*\{[^}]*position:\s*relative/s.test(panelSource) &&
      /\.detail-header \.series-popover\s*\{[^}]*left:\s*0[^}]*right:\s*0/s.test(panelSource) &&
      !/\.chip-series\s*\{[^}]*position:\s*relative/s.test(panelSource),
    '系列弹层挂在 header 上撑满面板宽度（挂 chip 上会被 overflow-x: hidden 裁掉右侧）',
  )
  check(
    panelSource.includes('useSeries') &&
      readFileSync(new URL('../src/composables/useSeries.js', import.meta.url), 'utf8').includes('catch') &&
      readFileSync(new URL('../src/api/anime.js', import.meta.url), 'utf8').includes('/series'),
    '系列是附加信息：取不到就当没有（不把面板拖进错误态）；接口 /api/anime/:id/series',
  )
  check(
    readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8').includes('@open="openAnime"'),
    '容器把面板的 open 事件接到 openAnime（全站一个面板，切换 = 改 activeAnimeId）',
  )
  /* 换成骨架屏之后：loading/error 不再需要 key（没有分支之间的过渡了），
     详情仍带 :key 让"换作品"重新挂载；整块过渡样式已删除，动效只剩骨架扫光。 */
  check(
    !panelSource.includes('key="loading"') &&
      !panelSource.includes('key="error"') &&
      panelSource.includes(":key=\"'detail-' + data.id\""),
    'loading/error 不再需要 key（无分支过渡）；详情仍带 :key 让换作品重新挂载',
  )
  check(
    !/\.phase-(enter|leave)/.test(panelSource) &&
      skeletonSource.includes('@keyframes sk-sweep'),
    '不再有整块过渡样式；动效只剩骨架屏扫光（局部位置在动）',
  )

  /* ── ④c 资源区：字幕组 → AI 位 → 资源列表 ──────────────────────────── */
  const { default: SubgroupBar } = await vite.ssrLoadModule('/src/components/detail/SubgroupBar.vue')
  const { default: ReleaseList } = await vite.ssrLoadModule('/src/components/detail/ReleaseList.vue')
  const { default: AiSlot } = await vite.ssrLoadModule('/src/components/detail/AiSlot.vue')

  const subgroupProps = {
    subgroups: [
      { id: 11, name: 'LoliHouse', mikanId: '223', rssId: '370' },
      { id: 12, name: 'SweetSub', mikanId: '212', rssId: '357' },
    ],
    activeId: 11,
    state: 'ready',
  }
  const bar = await renderToString(createSSRApp({ render: () => h(SubgroupBar, subgroupProps) }))
  check(bar.includes('LoliHouse') && bar.includes('SweetSub'), '字幕组条渲染出名称')
  // 注意类名顺序：Vue 把动态类排前面（选中项是 class="active chip"），
  // 所以这里按「带 active 的那个按钮是谁」来断，别按固定顺序拼字符串
  const activeChip = (bar.match(/<button class="[^"]*active[^"]*"[^>]*>([\s\S]*?)<\/button>/) || [])[0] || '（没有 active）'
  check(activeChip.includes('LoliHouse'), `当前字幕组有选中态 → ${activeChip.replace(/\s+/g, ' ').slice(0, 90)}…`)
  check(bar.includes('2 个'), '字幕组条显示总数')
  const barEmpty = await renderToString(
    createSSRApp({ render: () => h(SubgroupBar, { subgroups: [], state: 'empty' }) }),
  )
  check(barEmpty.includes('还没有字幕组资源'), '字幕组空态正常')
  const barError = await renderToString(createSSRApp({ render: () => h(SubgroupBar, { subgroups: [], state: 'error' }) }))
  check(barError.includes('字幕组没取到') && barError.includes('重试'), '字幕组错误态 + 重试按钮')

  // AI 位：四种状态都要能渲染（未配置 / 解析中 / 有标签 / 失败）
  const aiDisabled = await renderToString(createSSRApp({ render: () => h(AiSlot, { state: 'disabled' }) }))
  check(
    aiDisabled.includes('未配置') && aiDisabled.includes('设置页'),
    'AI 未配置态：标「未配置」并指路到设置页（不给使用者看环境变量名）',
  )
  const aiLoading = await renderToString(createSSRApp({ render: () => h(AiSlot, { state: 'loading' }) }))
  check(aiLoading.includes('正在解析这批资源的标签'), 'AI 解析中态正常')

  const aiTagFixtures = [
    { name: '1080P', type: 'res', match: ['1080P', '1920x1080'] },
    { name: '720P', type: 'res', match: ['720P', '1280x720'] },
    { name: '简繁内封', type: 'sub', match: ['简繁内封'] },
  ]
  const aiReady = await renderToString(
    createSSRApp({
      // 选中「同类型两个 + 跨类型一个」：这样才会同时出现 OR（组内）与 AND（组间）
      render: () =>
        h(AiSlot, {
          state: 'ready',
          tags: aiTagFixtures,
          activeNames: ['1080P', '720P', '简繁内封'],
          model: 'deepseek-chat',
          hasBatch: true,
        }),
    }),
  )
  check(
    aiReady.includes('AI 标签') && aiReady.includes('1080P') && aiReady.includes('简繁内封'),
    'AI 有标签时渲染出标签 chips',
  )
  const activeAiChip = (aiReady.match(/<button class="[^"]*active[^"]*"[^>]*>[\s\S]*?<\/button>/) || ['（没有 active）'])[0]
  check(activeAiChip.includes('1080P'), `已选标签有选中态 → ${activeAiChip.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}`)
  check(aiReady.includes('deepseek-chat'), '显示当前用的模型（便于确认没配错）')
  // 已选条件用连接词画出来（同类型 OR、跨类型 AND），清除入口在条件栏里
  check(
    aiReady.includes('class="sel-bar"') && aiReady.includes('OR') && aiReady.includes('AND') && aiReady.includes('清除'),
    '已选条件栏：AND / OR 连接词 + 清除入口',
  )
  const aiSlotSrc = readFileSync(new URL('../src/components/detail/AiSlot.vue', import.meta.url), 'utf8')
  check(
    aiSlotSrc.includes('isRevisionGroup') && aiSlotSrc.includes('PREFER') && /\.logic\.prefer/.test(aiSlotSrc),
    '修订版在已选区画成 PREFER（优选，不是 AND —— 免得以为没修订的集会被筛掉）',
  )
  check(
    aiSlotSrc.includes('filterableTags') && aiSlotSrc.includes('featureTexts') && /tag\.all/.test(aiSlotSrc),
    'AI 标「整批一致」的维度不做筛选项，只当只读特征展示（单条/同格式时不再"像没识别出来"）',
  )
  check(
    aiReady.includes('class="batch-toggle"') && aiReady.includes('单集') && aiReady.includes('合集') && aiReady.includes('全部'),
    '这批资源里有合集 → 出现「单集 / 合集 / 全部」三段切换',
  )

  // 信息性特征：与可筛标签是两类东西 —— 只读列表（li），点不动
  const aiWithInfo = await renderToString(
    createSSRApp({
      render: () =>
        h(AiSlot, { state: 'ready', tags: aiTagFixtures, info: ['均为内封简繁', '含 01-12 合集包'] }),
    }),
  )
  check(
    /<ul class="ai-info"[^>]*>[\s\S]*?<li class="ai-info-item"[^>]*>均为内封简繁<\/li>/.test(aiWithInfo),
    '信息性特征用只读列表展示（li 不是 button：点了不会筛）',
  )
  check(!aiReady.includes('ai-info'), '没有信息性特征时那一块不占位')
  check(!aiWithInfo.includes('batch-toggle'), '这批资源没有合集 → 不摆「合集」按钮（假控件不做）')

  /* 快速信息不依赖 AI 状态：没标签 / 没配 AI / 解析失败时都要看得见（它是本地规则算的） */
  const aiIdle = await renderToString(
    createSSRApp({ render: () => h(AiSlot, { state: 'idle', info: ['更新至第 07 话'] }) }),
  )
  check(
    aiIdle.includes('格式一致') && aiIdle.includes('更新至第 07 话'),
    '没有可用标签时说「格式一致，没有可筛的维度」，快速信息照样显示',
  )
  const aiDisabledInfo = await renderToString(
    createSSRApp({ render: () => h(AiSlot, { state: 'disabled', info: ['含 2 个合集包'] }) }),
  )
  check(aiDisabledInfo.includes('含 2 个合集包'), '没配 AI 时也能看到快速信息')
  const aiError = await renderToString(
    createSSRApp({ render: () => h(AiSlot, { state: 'error', message: 'AI 解析炸了' }) }),
  )
  check(aiError.includes('AI 解析炸了') && aiError.includes('重试'), 'AI 失败态：具体文案 + 重试按钮')

  const releaseItems = [
    {
      title: '[LoliHouse] 番名 - 01 [1080p][简繁]',
      magnet: `magnet:?xt=urn:btih:${'a'.repeat(40)}`,
      magnetHash: 'a'.repeat(40),
      torrentUrl: 'https://mikanime.tv/Download/x.torrent',
      sizeText: '1.2 GB',
      publishedText: '10-07 12:30',
    },
  ]
  const list = await renderToString(
    createSSRApp({ render: () => h(ReleaseList, { items: releaseItems, state: 'ready' }) }),
  )
  check(list.includes('1.2 GB') && list.includes('10-07 12:30'), '资源条目显示大小与时间（都是后端成品字符串）')
  check(list.includes('磁力') && list.includes('种子'), '资源条目有「复制磁力 / 下载种子」两个入口')
  check(list.includes('1 个种子'), '资源区显示条数')
  const listEmpty = await renderToString(
    createSSRApp({ render: () => h(ReleaseList, { items: [], state: 'empty' }) }),
  )
  check(
    listEmpty.includes('这部暂时没有资源'),
    '资源空态正常（中性文案：没有字幕组时不该说"这个字幕组"）',
  )

  /* ── ④d AI 标签筛选资源（面板「AI 位 → 资源列表」的联动）──────────── */
  const filterItems = [
    {
      title: '[A] 番名 - 01 [1080P][简繁内封]',
      magnet: `magnet:?xt=urn:btih:${'b'.repeat(40)}`,
      magnetHash: 'b'.repeat(40),
      torrentUrl: '',
      sizeText: '1.4 GB',
      publishedText: '10-07 12:00',
    },
    {
      title: '[A] 番名 - 02 [720P][繁日]',
      magnet: `magnet:?xt=urn:btih:${'c'.repeat(40)}`,
      magnetHash: 'c'.repeat(40),
      torrentUrl: '',
      sizeText: '700.0 MB',
      publishedText: '10-07 13:00',
    },
  ]
  const pick1080 = [{ name: '1080P', type: 'res', match: ['1080P'] }]
  const filtered = await renderToString(
    createSSRApp({ render: () => h(ReleaseList, { items: filterItems, state: 'ready', activeTags: pick1080 }) }),
  )
  check(filtered.includes('1080P') && !filtered.includes('720P'), '按标签筛后只剩匹配的资源')
  check(filtered.includes('筛选后 1 / 共 2'), '筛选时显示「筛选后 N / 共 M」')

  const noMatch = await renderToString(
    createSSRApp({
      render: () =>
        h(ReleaseList, {
          items: filterItems,
          state: 'ready',
          activeTags: [{ name: '不存在', type: 'other', match: ['根本不出现的写法'] }],
        }),
    }),
  )
  check(
    noMatch.includes('没有符合所选标签的资源') && noMatch.includes('清除筛选'),
    '筛空了给「没有符合所选标签的资源」+ 清除筛选（不误报成「字幕组没资源」）',
  )

  /* ── ④e 字幕组平铺展示（不横滑）────────────────────────────────────── */
  const barSource = readFileSync(new URL('../src/components/detail/SubgroupBar.vue', import.meta.url), 'utf8')
  check(
    /\.chips\s*\{[^}]*flex-wrap:\s*wrap/s.test(barSource) && !barSource.includes('overflow-x'),
    '字幕组全部平铺（flex-wrap: wrap，没有横向滚动）',
  )

  /* ── ④d 简介展开改成框内滚动 + 资源区三块都挂上了 ───────────────────── */
  check(/\.summary\.expanded\s*\{[^}]*max-height/s.test(panelSource), '简介展开态有 max-height（不把面板撑高）')
  check(/\.summary\.expanded\s*\{[^}]*overflow-y:\s*auto/s.test(panelSource), '简介展开态 overflow-y: auto（可滑动）')
  check(
    panelSource.indexOf('<SubgroupBar') < panelSource.indexOf('<AiSlot') &&
      panelSource.indexOf('<AiSlot') < panelSource.indexOf('<ReleaseList'),
    '面板按「字幕组 → AI 位 → 资源列表」顺序挂好三块',
  )


  /* ── ⑤ 面板开关逻辑（useAnimeDetail：纯状态机，不依赖 DOM） ─────────── */
  const { useAnimeDetail } = await vite.ssrLoadModule('/src/composables/useAnimeDetail.js')
  const panelState = useAnimeDetail()
  check(panelState.visible.value === false, '初始状态：面板关着')

  await panelState.open(firstItem.id)
  check(
    panelState.visible.value && panelState.uiState.value === 'ready' && panelState.data.value?.id === firstItem.id,
    `点海报 → 面板打开并拿到档案（id=${firstItem.id}）`,
  )

  const loaded = panelState.data.value
  await panelState.open(firstItem.id)
  check(panelState.data.value === loaded, '同一张海报再点一次：不重取（连内容对象都不换）')

  panelState.close()
  check(
    panelState.visible.value === false && panelState.data.value === loaded,
    '关闭只收起、不清数据（切页面回来能直接摆回原内容）',
  )

  const secondItem = items[1]
  await panelState.open(secondItem.id)
  check(panelState.data.value?.id === secondItem.id, `换一张海报 → 内容切到新作品（id=${secondItem.id}）`)

  const badPanel = useAnimeDetail()
  await badPanel.open(99999999)
  check(
    badPanel.uiState.value === 'error' && badPanel.error.value?.code === 'NOT_FOUND',
    `不存在的 id → 面板进错误态且错误码正确（${badPanel.error.value?.code}）`,
  )
  await badPanel.retry()
  check(badPanel.uiState.value === 'error', '错误态重试仍失败 → 保持错误态（不会变空白）')
  badPanel.close()
  check(badPanel.visible.value === false && badPanel.uiState.value === 'empty', '失败后关闭 → 干净复位')

  // 重新打开同一部：内容对象没被丢掉（不会先闪一下骨架再回来）
  await panelState.open(secondItem.id)
  check(panelState.data.value?.id === secondItem.id && panelState.visible.value === true, '重新打开同一部：原内容还在')

  /* 面板状态装在**容器**里（App.vue）而不是页面里 —— 这正是「切页面/换季后面板还在」的前提 */
  const appSource = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8')
  const discoverSource = readFileSync(new URL('../src/pages/DiscoverPage.vue', import.meta.url), 'utf8')
  check(
    appSource.includes('useAnimeDetail()') && !discoverSource.includes('useAnimeDetail'),
    '面板状态只装一次（App.vue）：切到别的页再回来不会丢',
  )

  /* ── ⑥ 设置页：清单由后端下发 + 草稿/保存/还原 + 导入导出（写的是隔离库）── */
  const { useSettings } = await vite.ssrLoadModule('/src/composables/useSettings.js')
  const store = useSettings()
  await store.load()

  /* 基础模式：**只放必要配置** —— advanced 项一个都不许出现（"改过的项也塞进来"那条已砍掉），
     它们交给顶栏「高级」角标交代。先在基础模式验，再切高级验结构。 */
  check(
    store.groups.value.flatMap((g) => g.sections).flatMap((s) => s.fields).every((f) => !f.advanced),
    `基础模式只显示必要项 → ${store.groups.value.flatMap((g) => g.sections).flatMap((s) => s.fields).length} 项`,
  )
  store.showAdvanced.value = true
  check(store.groups.value.length >= 4, `高级模式：设置分组 ${store.groups.value.length} 个（页面按分组渲染）`)
  /* 页面就按 sections[].fields 渲染：结构错了会「渲染函数抛错 → 页面卡在加载态」，
     而 SSR 首帧没有数据、根本不渲染卡片，所以必须在这里直接验结构 */
  check(
    store.groups.value.every(
      (group) => Array.isArray(group.sections) && group.sections.every((section) => Array.isArray(section.fields)),
    ),
    '分组结构：每个 group 的 sections[].fields 都在（模板按它渲染）',
  )
  check(store.data.value.fields.length >= 25, `可配置项 ${store.data.value.fields.length} 个（表单由后端清单驱动）`)
  const secretField = store.data.value.fields.find((f) => f.type === 'secret')
  check(
    secretField.value === null && typeof secretField.hasValue === 'boolean',
    `密钥项只回「配没配 + 打码」→ ${secretField.path}`,
  )

  store.setValue('worker.gapMs', 888)
  check(store.dirtyCount.value === 1 && store.isDirty(secretField) === false, '改动只进草稿（dirtyCount=1）')

  // 改回原值应当自动取消这次改动：开关点两下、数字改回去，都不该还挂着「撤销」
  store.setValue('worker.gapMs', 350)
  check(store.dirtyCount.value === 0, '把值改回原样 → 改动自动取消（不再挂着「撤销」）')
  store.setValue('worker.gapMs', 888)
  await store.save()
  check(/已保存/.test(store.message.value), `保存提示 → ${store.message.value}`)
  check(store.dirtyCount.value === 0, '保存后草稿清空')
  const gapField = store.data.value.fields.find((f) => f.path === 'worker.gapMs')
  check(gapField.value === 888 && gapField.overridden === true, '保存后显示后端实际值 + 标记「已改」')

  await store.importPayload({
    kind: 'soraikahub-settings',
    version: 1,
    values: { 'worker.idleMs': 4321, 'legacy.field': 1 },
  })
  check(
    /已导入/.test(store.message.value) && /忽略 1 个未知项/.test(store.message.value),
    `导入合并 + 未知项忽略 → ${store.message.value}`,
  )

  await store.resetAll()
  check(store.data.value.overridden.length === 0, '全部还原后没有覆盖项（隔离库回到干净状态）')

  /* ── 测试连接：真的经由「前端 → 代理 → 后端 → 目标」走一遍 ─────────── */
  await store.testField('mikan.bases', `${DEV}/api/health`)
  check(store.testStates.value['mikan.bases'] === 'success', `连通 → ${store.testDetails.value['mikan.bases']}`)
  await store.testField('mikan.bases', 'http://127.0.0.1:1')
  check(store.testStates.value['mikan.bases'] === 'error', `不通 → ${store.testDetails.value['mikan.bases']}`)

  /* ── 页面契约（来源级）── */
  const settingsSource = readFileSync(new URL('../src/pages/SettingsPage.vue', import.meta.url), 'utf8')
  const controlSource = readFileSync(new URL('../src/components/settings/FieldControl.vue', import.meta.url), 'utf8')
  const baseCss = readFileSync(new URL('../src/styles/base.css', import.meta.url), 'utf8')

  check(
    settingsSource.includes('v-for="group in groups"') && settingsSource.includes('v-for="section in group.sections"'),
    '设置页按后端清单渲染分组与字段（不在页面里写死）',
  )
  check(settingsSource.includes('<FieldControl'), '字段输入/选择交给 FieldControl（页面只摆结构）')
  check(
    settingsSource.includes('class="field-head"') &&
      settingsSource.includes('class="field-flag"') &&
      settingsSource.includes('class="field-actions"'),
    '字段标签行：名称 + 属性图标 + 行操作（属性不靠常驻文字堆）',
  )
  check(
    settingsSource.includes('class="mode-switch"') && settingsSource.includes('showAdvanced') && !settingsSource.includes('tune-toggle'),
    '有「基础 / 高级」切换：基础 = 只显示必要配置（不填就用不了的那几项）',
  )
  check(
    settingsSource.includes('hiddenAdvancedCount') && /展开 \$\{hiddenAdvancedCount\} 项调参项/.test(settingsSource),
    '高级那一侧会说明「还能展开多少项调参」，不是一句「高级」了事',
  )
  check(
    settingsSource.includes('field.hint') && /:title="field\.hint/.test(settingsSource),
    '字段说明改成鼠标悬浮显示（行脚只留测试结果，表单不再像说明书）',
  )
  /* 时长 = **多列滚轮**（用户要的形状）：`xx s xx ms` / `xx m xx s` / `xx h xx m` / `xx d xx h xx m`。
     先前试过"输入框直接写 1m 30s"，但时长的量级从 350ms 到 7 天，滚轮才是"看得见、滚得动"的形态。 */
  check(
    controlSource.includes('class="wheels dur"') &&
      /DUR_TIERS[\s\S]{0,200}\['s', 59, 1\][\s\S]{0,80}\['ms', 990, 10\]/.test(controlSource) &&
      controlSource.includes("['d', 90, 1]"),
    '时长弹层是多列滚轮，列按量级自动选（s·ms / m·s / h·m / d·h·m）',
  )
  check(
    /function onDurScroll[\s\S]{0,600}total \+= n \* DUR_FACTOR\[col\.unit\]/.test(controlSource) &&
      controlSource.includes('emit(\'update\', total)'),
    '滚轮停下后按各列求和换算成毫秒提交（不是把某一列的数字当总量）',
  )
  check(
    controlSource.includes('@wheel.prevent="durStep') && controlSource.includes('startDurDrag'),
    '时长滚轮支持鼠标滚轮逐格 + 按住拖动',
  )
  check(
    !/已写入数据库|全部写入数据库/.test(settingsSource),
    '落库是静默的：页面上不出现「已写入数据库」这类记账提示，也不要求用户点按钮',
  )

  /* 可视化交互：能用点就不让人打字 */
  check(controlSource.includes('PopoverPanel'), '字段控件带浮层（可视化选择）')
  /* 数值 / 时长：**就是一行输入框 + 只读单位** ——
     之前那套「按钮 → 弹层 → 加减号 / 滚轮 / 拖拽 / 单位下拉」占了一半代码，
     还因为"步长与单位推导各算各的"滚动时数字乱抖。轻量化的正解是**不自己造控件**。 */
  check(
    !controlSource.includes('DURATION_PRESETS') &&
      controlSource.includes('class="stepper"') &&
      controlSource.includes('class="wheels dur"'),
    '编辑都在弹层里：数值 = 输入框 + 加减，时长 = 多列滚轮（行内只显示结果）',
  )
  /* 旧的 `commitNum`（文本写单位）已随滚轮方案删除；复合写法的解析能力仍在 utils 里被别处用 */
  check(
    !/function commitNum/.test(controlSource) && !/function onUnitChange/.test(controlSource),
    '旧的「文本换算 / 单位下拉」两条路径已清除（不留死代码）',
  )
  check(
    controlSource.includes('formatDuration(stepSize.value)') &&
      /Math\.max\(factor, 100\)/.test(controlSource),
    '步长跟着显示单位走（`m` 就 ±1 分钟）—— 滚动调参时数字与单位都不会抖',
  )
  const { formatDuration } = await vite.ssrLoadModule('/src/utils/duration.js')
  check(
    formatDuration(1500) === '1s 500ms' && formatDuration(30000) === '30s' && formatDuration(5400000) === '1h 30m',
    `时长文案是 s/ms 复合写法 → ${formatDuration(1500)} / ${formatDuration(30000)} / ${formatDuration(5400000)}`,
  )
  const useSettingsSrc = readFileSync(new URL('../src/composables/useSettings.js', import.meta.url), 'utf8')
  check(
    useSettingsSrc.includes('成功 · ') && !/\$\{res\.status\} · /.test(useSettingsSrc),
    '测试连接成功只说「成功 · 681ms」，不把 200 这种状态码甩给使用者',
  )
  check(
    /\.wheel-item/.test(controlSource) && controlSource.includes('onWheelScroll') && controlSource.includes('scroll-snap-type'),
    '时刻：滚轮选择（时 / 分两列，scroll-snap 吸附，中间那格即选中值）',
  )
  /* 时刻：**两列滚轮**（时 / 分），和「时长」同一套手感（滚一下一格、可拖、中间格高亮） */
  check(
    controlSource.includes("panel === 'time'") &&
      controlSource.includes('hourWheel') &&
      controlSource.includes('minuteWheel') &&
      controlSource.includes('pickHour') &&
      !/type="time"/.test(controlSource),
    '时刻是时 / 分两列滚轮（原生 input[type=time] 已移除）',
  )
  check(
    controlSource.includes('@wheel.prevent="wheelBy') && controlSource.includes('startWheelDrag'),
    '时刻滚轮自己接管滚轮（一格一格）与拖拽（原生滚动区鼠标拖不动）',
  )
  /* 交互"渲染出来了吗"这类断言要用 SSR 真渲染，e2e 这里的作用域拿不到 vite 实例，
     硬塞进去会把整份验收弄崩（踩过）。验证放在人工过一遍 + 下面的 class/属性断言里。 */
  /* 时长可以直接写单位：10s / 1.5m / 2h —— 不让人先把 10 秒换算成 10000 */
  /* 时长：**不再有单位下拉**，输入框直接写完整写法（显示什么样就能填什么样） */
  check(
    !controlSource.includes('class="step-unit"') && controlSource.includes('class="wheels dur"'),
    '时长不再有「数值 + 单位下拉」两段式（换成多列滚轮 s·ms / m·s / h·m / d·h·m）',
  )
  check(
    parseDuration('1m 30s') === 90000 &&
      parseDuration('7d') === 604800000 &&
      parseDuration('1d 12h') === 129600000 &&
      parseDuration('1h 30m 5s') === 5405000 &&
      parseDuration('1.5s') === 1500 &&
      parseDuration('350ms') === 350 &&
      parseDuration('10分钟') === 600000 &&
      parseDuration('乱写') === null,
    '复合写法能解析：`1d 12h` / `1h 30m 5s` / `1.5s` 都认，乱写返回 null（回滚不发脏值）',
  )
  check(
    controlSource.includes('@wheel.prevent="onWheel"') &&
      controlSource.includes('startDrag') &&
      controlSource.includes('onDrag'),
    '弹层里支持鼠标滚轮 + 左右拖动微调',
  )
  check(
    /\.shell \.unit\s*\{[^}]*margin-left:\s*auto/s.test(controlSource) && controlSource.includes('class="unit pill pill-muted"'),
    '单位胶囊贴在行尾（输入框左对齐、数值/单位不各贴一边）',
  )
  check(
    controlSource.includes('width="anchor"') &&
      /position:\s*fixed/.test(readFileSync(new URL('../src/components/ui/PopoverPanel.vue', import.meta.url), 'utf8')) &&
      readFileSync(new URL('../src/components/ui/PopoverPanel.vue', import.meta.url), 'utf8').includes('getBoundingClientRect'),
    '弹层与字段同宽，且用 fixed + 锚点坐标定位（不会被滚动容器的 overflow 裁掉）',
  )
  check(
    !controlSource.includes('常用时长') && !/pop-hint[^>]*>[\s\S]{0,80}单位 \{/.test(controlSource),
    '弹层底部不再堆「单位 ms · 也可以直接写单位」这类说明，只留换算结果',
  )
  check(
    controlSource.includes('commitEdit') && controlSource.includes('editText'),
    '交互界面里的数值输入失焦/回车即提交，解析不了就回滚',
  )
  /* 设置页**自己必须能滚**：父级 `.main-content` 是 height:100vh + overflow:hidden，
     页面不设 height/overflow 的话，超出一屏的字段（每日更新时刻、数据源）会被直接裁掉。 */
  check(
    /\.settings\s*\{[^}]*height:\s*100%/s.test(settingsSource) &&
      /\.settings\s*\{[^}]*overflow-y:\s*auto/s.test(settingsSource),
    '设置页是滚动容器（height:100% + overflow-y:auto）—— 一屏外的字段能滚到，不会被裁',
  )
  check(
    /\.fields\s*\{[^}]*container-type:\s*inline-size/s.test(settingsSource) &&
      /@container \(min-width:\s*520px\)[\s\S]{0,120}\.field\.wide/s.test(settingsSource),
    '「宽字段占两格」按**容器宽度**判断（容器查询）—— 只有一格时不再被顶出卡片',
  )

  /* AI 提供商：**输入框本身就是搜索框**（不再另放一个搜索框、也不再有两个下拉箭头）；
     输入的名字目录里没有 → 末尾出现「＋ 添加「xxx」」= 自定义。 */
  check(
    controlSource.includes("field.type === 'provider'") &&
      controlSource.includes('provider-input') &&
      !controlSource.includes('pop-search') &&
      controlSource.includes('canAddCustom') &&
      controlSource.includes('添加「'),
    'AI 提供商：输入框即搜索框；名字不在目录里 → 「添加「xxx」」',
  )
  check(
    controlSource.includes("emit('pick-provider'") && controlSource.includes('models: item.models'),
    '选中提供商时把该家的模型名一起带过去（下面的参数自动补齐）',
  )
  check(
    controlSource.includes('prov-state') && controlSource.includes('已配置') && controlSource.includes('待填 Key'),
    '提供商列表用「图标 + 文字 + 颜色」标出状态：已配置 / 待填 Key',
  )
  check(controlSource.includes('field.models') && controlSource.includes('可用模型'), '模型：从接口读取候选列表')
  check(
    controlSource.includes('class="step-btn"') && controlSource.includes('stepSize'),
    '交互界面里有加减（步进按量级：秒级 1s / 分钟级 30s / 小时级 5m）',
  )
  /* 踩过：行内按钮自带图标 + 后缀又挂一个同款图标 = 两个图标（每日更新时刻那两个时钟） */
  check(
    /const hasPanel = computed\(\(\) => Boolean\(props\.field\.models\)/.test(controlSource) &&
      (controlSource.match(/data-popover-anchor/g) || []).length >= 1,
    '时刻 / 数值不再挂后缀按钮（不会出现两个图标）；弹层锚点自带 anchor',
  )
  /* ── 多源地址：可拖拽排序 / 可增删 / 每条单独测 / 一键全测 ───────────── */
  const listEditorSource = readFileSync(resolve('src/components/settings/SourceListEditor.vue'), 'utf8')
  check(
    listEditorSource.includes('draggable="true"') &&
      listEditorSource.includes('@dragover') &&
      listEditorSource.includes('@drop.prevent'),
    '多源地址可拖拽排序（另有上移 / 下移按钮，键盘也能改顺序）',
  )
  check(
    listEditorSource.includes('添加一行') &&
      listEditorSource.includes('测试全部') &&
      listEditorSource.includes("$emit('test-row'"),
    '多源地址可增删，每条可单独测，也能一键全测',
  )
  check(
    listEditorSource.includes('src-ms') && listEditorSource.includes('msOf'),
    '每条地址测完就在图标旁显示延迟（成功 `23ms` / 失败「失败」），不用点 tooltip',
  )
  check(
    !/v-if="field\.type === 'url' \|\| field\.type === 'list'"/.test(controlSource),
    '多源列表不再挂字段级「测试连接」按钮（每条能测 + 底部测试全部，第三个入口是冗余）',
  )
  check(
    controlSource.includes('SourceListEditor') && controlSource.includes("items.join('\\n')"),
    '多源地址用列表编辑器（界面是数组，存库仍是换行文本 —— 线上格式没变）',
  )
  /* 踩过：`.shell` 是固定 40px 高的居中 flex —— 多行列表塞进去会**上下同时溢出**
     （第一行压住字段名、footer 压住下一节）。必须有 `is-list` 让它按内容长高。 */
  check(
    controlSource.includes("'is-list': field.type === 'list'") &&
      /\.shell\.is-list\s*\{[^}]*height:\s*auto/s.test(controlSource),
    '多源列表那一格高度自适应（class 真的挂上了，不再是固定 40px 居中）',
  )
  const settingsStoreSource = readFileSync(resolve('src/composables/useSettings.js'), 'utf8')
  check(
    settingsStoreSource.includes('fetchAiProviders') && settingsStoreSource.includes('providerModels'),
    'AI 供应商取自社区目录（models.dev）：候选模型先用目录里的、再用接口实时结果覆盖',
  )
  check(
    settingsStoreSource.includes('rowTests') && settingsStoreSource.includes('testRow'),
    '多源地址每一行有独立测试状态（不是只给整组一个状态）',
  )
  check(
    /async function testEach[\s\S]{0,900}state:\s*'testing'/.test(settingsStoreSource),
    '「测试全部」先把每条置成"测试中"（行上的转圈会动），谁先回来谁先变',
  )
  check(
    /async function testEach\(/.test(settingsStoreSource) &&
      /Promise\.all\([\s\S]{0,400}testSetting\(path, url\)/.test(settingsStoreSource),
    '「测试全部」是**逐条并发**：谁先回来谁先显示 ms（不等全部测完）',
  )
  check(
    listEditorSource.includes('@keyframes spin') && listEditorSource.includes('.mini-spinner'),
    '多源列表自带转圈样式（scoped 样式跨组件不生效 —— 之前"测试中看不到动画"就是它）',
  )
  check(
    /canAddCustom[\s\S]{0,260}toLowerCase\(\)/.test(controlSource),
    '「添加「xxx」」的判定不分大小写（输入 deepseek 不会再冒出一条自定义，看着像重复）',
  )

  check(
    controlSource.includes('v-if="unitOf"') &&
      /const unitOf = computed/.test(controlSource) &&
      /isDuration\.value \? '' : props\.field\.unit/.test(controlSource),
    '时长行的值里已经带单位（`7d`）→ 不再挂重复的单位胶囊；非时长数值仍显示字段单位',
  )
  /* 里外一致：数值与单位必须走**同一份**换算。
     踩过的坑：弹层里是 `1`（1 分钟），行外却显示 `60000` + `m` —— 两处各算各的。 */
  check(
    unitForMs(350) === 'ms' &&
      unitForMs(1000) === 's' &&
      unitForMs(60000) === 'm' &&
      unitForMs(3600000) === 'h' &&
      unitForMs(86400000) === 'd' &&
      unitForMs(0, 'ms') === 'ms',
    '单位按值推导：350→ms、1000→s、60000→m、1h→h、1d→d（除不尽退回毫秒）',
  )
  /* 提交时必须换算**回毫秒**：界面显示 `10 m`，存进库的要是 `600000` ——
     设置项的值统一以毫秒入库，绝不能把界面上的数字原样存进去（那会让
     「1 分钟的缓存」变成「1 毫秒」，等于永远不缓存）。 */
  check(
    toMilliseconds(1, 'm') === 60000 &&
      toMilliseconds(10, 'm') === 600000 &&
      toMilliseconds(30, 's') === 30000 &&
      toMilliseconds(2, 'h') === 7200000 &&
      toMilliseconds(500, 'ms') === 500,
    '单位换算回毫秒：界面 `10 m` → 入库 `600000`（库里永远是毫秒）',
  )
  check(
    /const parsed = parseDuration\(editText\.value, unitFactor\.value\)/.test(controlSource) ||
      /function onDurScroll[\s\S]{0,600}DUR_FACTOR\[col\.unit\]/.test(controlSource),
    '提交走换算（写单位就按单位算 / 滚轮按列求和），不是把某个数字原样提交',
  )
  check(
    toDisplayText(60000, 'm') === '1' &&
      toDisplayText(350, 'ms') === '350' &&
      toDisplayText(90000, 's') === '90' &&
      toDisplayText(1500, 'ms') === '1500',
    '数值与单位用同一份换算 → 不会再出现「点进去是 1、外面是 60000」',
  )
  check(
    controlSource.includes('syncEditText') &&
      /watch\(\s*\(\) => \[displayUnit\.value, props\.field\.path\]/.test(controlSource) &&
      !controlSource.includes('onUnitChange'),
    '输入框每次换字段/换单位都按 formatDuration 重算（不再有「改单位数字没改」那条路径）',
  )

  check(
    /const factor = UNITS\.find\(\(u\) => u\.value === displayUnit\.value\)\?\.factor \|\| 1/.test(controlSource) &&
      /Math\.max\(factor, 100\)/.test(controlSource),
    '时长步进 = 一个当前显示单位（显示 m 就 ±1 分钟）—— 保证整除，滚动时单位不会跳变',
  )

  /* 密钥与对齐 */
  check(controlSource.includes('MASK') && /\.shell input\.masked/.test(controlSource), '已配置的密钥显示掩码（不是空白）')
  check(
    /\/\* 后缀按钮/.test(controlSource) && controlSource.includes('class="suffix-btn"'),
    '测试连接 / 显示隐藏 / 可视化选择统一放在输入框后缀区（各种类型对齐一致）',
  )
  check(
    /\.shell input\.num\s*\{[^}]*text-align:\s*left/s.test(controlSource),
    '所有输入框一律左对齐（数值/时长也左对齐，和地址/文本行同一起点）',
  )
  check(
    controlSource.includes('hourWheel') && !settingsSource.includes('hourWheel'),
    '时刻控件实现在 FieldControl 里（页面只摆结构，不碰控件）',
  )
  check(!/#[0-9a-f]{6}/i.test(settingsSource) && !/rgba\(0, 0, 0/.test(settingsSource), '颜色与阴影都走令牌')

  /* 统一风格：卡片/输入框/胶囊来自全局类 */
  check(
    settingsSource.includes('class="card card-surface"') && controlSource.includes('class="shell input-surface"'),
    '卡片 / 输入框用全局 .card-surface / .input-surface（不再各页各写一份描边底色）',
  )
  check(settingsSource.includes('class="topbar topbar-surface"'), '顶栏与首页/发现页同一套 .topbar-surface')
  check(settingsSource.includes('<StateBlock'), '三态用全局 StateBlock')
  check(settingsSource.includes('pill pill-accent') && controlSource.includes('pill pill-muted'), '徽标/单位用全局 .pill')
  check(/\.pill\s*\{[^}]*border-radius/s.test(baseCss), '胶囊形状在 base.css 里统一定义')
  check(
    /\.settings\s*\{[^}]*font-family:\s*var\(--font-body\)/s.test(settingsSource),
    '整页无衬线（工具页不用楷体）',
  )
  check(
    settingsSource.includes('v-for="section in group.sections"') && settingsSource.includes('class="section-title"'),
    '卡片内按小节分块',
  )
  check(
    store.groups.value.flatMap((group) => group.sections).some((section) => section.label),
    `小节名来自后端清单 → ${JSON.stringify(store.groups.value.flatMap((g) => g.sections).map((s) => s.label).slice(0, 4))}`,
  )
  /* 模板循环变量必须与数据结构同名：改结构时漏改一处 v-for 就会渲染抛错、页面卡住 */
  check(
    !/in block\.[a-z]/.test(settingsSource) && settingsSource.includes('v-for="field in section.fields"'),
    '模板循环变量与数据结构一致（当前是 section.fields）',
  )
  check(/grid-template-columns:\s*repeat\(auto-fill, minmax\(240px, 1fr\)\)/.test(settingsSource), '字段用自适应多列铺满')
  check(!/max-width:\s*920px/.test(settingsSource), '页面撑满，没有被限宽')
  check(settingsSource.includes('class="card-save"') && settingsSource.includes('save-btn'), '每张卡片底部有自己的保存按钮')
  /* 保存 = 整组落库（不是只写 diff）：否则库里只有改过的那几个键，看着像「设置没存」 */
  const useSettingsSource = readFileSync(new URL('../src/composables/useSettings.js', import.meta.url), 'utf8')
  check(
    settingsSource.includes('pathsOf(group)') && !/saveGroup = \(group\) => save\(dirtyPathsOf/.test(settingsSource),
    '保存卡片 = 提交整组字段当前值（库里能看到整组配置，不是只有改动项）',
  )
  check(
    useSettingsSource.includes('snapshotOf') && useSettingsSource.includes("field.type === 'secret'"),
    '整组落库时跳过密钥（不回显的值提交上去 = 把已配的 key 删掉）',
  )
  /* 保存按钮不做「没改动就灰掉」：灰按钮不告诉人为什么点不动 */
  const pageSrc = readFileSync(new URL('../src/pages/SettingsPage.vue', import.meta.url), 'utf8')
  check(
    /:disabled="saving"/.test(pageSrc) && !/\.length \|\| saving/.test(pageSrc),
    '保存按钮一直可点（不再因为「没改动」变灰）',
  )
  check(
    pageSrc.includes('无变化') && useSettingsSource.includes('markUnchanged') && /\.save-btn\.idle/.test(pageSrc),
    '没改动时点一下回「无变化」（蓝色 + 完整文案，不是灰字）',
  )
  check(
    /\.save-btn\.idle\s*\{[^}]*status-info/s.test(pageSrc) && /无变化 · 已是最新/.test(useSettingsSource),
    '「无变化」用蓝色 + 「无变化 · 已是最新」，并在消息行说明',
  )
  check(
    pageSrc.includes('changedInAdvanced') && /\.mode-badge/.test(pageSrc) && useSettingsSource.includes('changedInAdvanced'),
    '基础模式下改过的项被收起时，「高级」按钮上有角标交代',
  )
  check(
    !settingsSource.includes('onSaveAll') && /loadStoredSettings|fillMissingSettings/.test(readFileSync(new URL('../../Server/src/api/pages/settings.js', import.meta.url), 'utf8')),
    '落库不需要用户点按钮：启动时后端静默补齐全量配置（前端只保留每卡片的「保存」）',
  )
  check(/保存中\.\.\./.test(settingsSource) && /保存成功/.test(settingsSource), '保存按钮有「保存中…/保存成功」反馈')
  check(
    controlSource.includes('IconPlugConnected') && controlSource.includes('class="mini-spinner"'),
    '地址行后缀是「测试连接」按钮（插头 → 转圈 → 对勾/叉）',
  )
  check(controlSource.includes('IconEye') && /'password'/.test(controlSource), '密钥：密码框 + 显示/隐藏按钮')
  check(controlSource.includes('class="switch"') && controlSource.includes('switch-thumb'), '布尔项是滑动开关')
  /* 导出只有一份（含密钥的完整备份）：脱敏版导出去没法用，不该让用户先做选择 */
  check(
    settingsSource.includes('@click="onExport(true)"') &&
      !settingsSource.includes('导出（含密钥）') &&
      settingsSource.includes('全部还原'),
    '导出只有一个入口（完整备份，含密钥），另有「全部还原」',
  )

  /* ── ⑧ 资源区：集数徽标 / 版本标记 / 区块对齐 / 筛选口径 ───────────── */
  const { dedupeLatestRevisions, episodeOf, isBatchEpisode, releaseHighlights } = await vite.ssrLoadModule(
    '/src/utils/episode.js',
  )
  check(episodeOf('[LoliHouse] 番名 - 04 [1080P][简繁]') === '04', `从文件名取集数 → ${episodeOf('[LoliHouse] 番名 - 04 [1080P][简繁]')}`)
  check(episodeOf('[A] 番名 第12集 [720P]') === '12', '「第 N 集」写法也认')
  check(episodeOf('[A] 番名 [01-12][BDRip]') === '01-12' && isBatchEpisode('01-12'), '合集识别成范围（01-12）')
  check(episodeOf('没有集数的名字') === '', '取不到集数时返回空（界面显示「—」而不是乱猜一集）')
  /* 实际踩到的：CR/CATCHPLAY 这类源用 S01E12，规则太死就整条识别不出来 */
  check(
    episodeOf(
      '[黒ネズミたち] 海贼王 / One Piece - 1180 (B-Global 3840x2160 HEVC AAC MKV)',
    ) === '1180',
    '4 位集号（长篇如「- 1180」）也认 —— 之前写死 1-3 位，直接整条漏掉',
  )
  check(
    episodeOf(
      '[Nix-Raws] 画完这个再去死 / これ描いて死ね / Kore Kaite Shine S01E12 [CATCHPLAY WEB-DL 1080p AVC AAC][简繁内封]',
    ) === '12',
    'SxxExx 写法（欧美 / CR / CATCHPLAY 源）也认 → S01E12 = 12',
  )
  check(
    episodeOf('[A] 番名 E07 [1080p]') === '07' && episodeOf('未命名的电影 1080p') === '',
    'Exx 认集号；但 1080p / WEB-DL 这类不会被误当集号',
  )
  check(
    episodeOf('[A] 番名 04v2 [1080P]') === '04' && episodeOf('[A] 番名 12v3 [1080p]') === '12',
    '裸写的 04v2（没方括号也没前缀）也认集号',
  )
  /* 合集：范围后面还跟字（`[01-26 合集]`）也要吃住 —— 实际踩到过 */
  check(
    episodeOf('[LoliHouse] MAO摩绪 [01-26 合集][WebRip 1080p HEVC-10bit AAC][简繁内封字幕][Fin]') === '01-26' &&
      isBatchEpisode('01-26'),
    '「[01-26 合集]」这种写法照样识别成合集 01-26（且判为合集）',
  )

  /* 整体特征由规则算（不问 AI）：只说"更新到几集"和"有没有合集包" */
  check(
    JSON.stringify(
      releaseHighlights([
        { title: '[A] 番名 - 01 [1080P]' },
        { title: '[A] 番名 - 07 [1080P]' },
        { title: '[A] 番名 [01-12][1080P]' },
      ]),
    ) === JSON.stringify(['更新至第 07 话', '含 1 个合集包', '共 3 条资源']),
    '整体特征本地算：更新至第 07 话 + 含 1 个合集包 + 共 3 条资源（兜底）',
  )
  check(
    releaseHighlights([{ title: '没有集数的名字' }]).length === 1 &&
      releaseHighlights([{ title: '没有集数的名字' }])[0] === '共 1 条资源',
    '算不出集数也不空着：兜底显示「共 N 条资源」（简报永远有内容）',
  )

  /* ── 修订版筛的语义：**同集的旧版让位**（不是"只显示修订版"）──────────────
     这条是踩过坑的：一开始写成「只留 revision >= 2」，结果是「只有原版的集整集消失」。 */
  const revItems = [
    { title: '[A] 番名 - 07v1 [1080P]', revision: 1 },
    { title: '[A] 番名 - 07v2 [1080P]', revision: 2 },
    { title: '[A] 番名 - 08 [1080P]', revision: 1 },
    { title: '[A] 番名 - 09 [720P]', revision: 1 },
    { title: '[A] 番名 - 09 [1080P]', revision: 1 },
    { title: '[A] 番名 [01-12][1080P]', revision: 1 },
  ]
  const deduped = dedupeLatestRevisions(revItems)
  check(
    deduped.length === 5 && deduped.some((i) => i.title.includes('07v2')) && !deduped.some((i) => i.title.includes('07v1')),
    `同集旧版让位：07v1 去掉、07v2 留下（共 ${deduped.length} 条）`,
  )
  check(
    deduped.some((i) => i.title.includes('- 08')) && deduped.filter((i) => i.title.includes('- 09')).length === 2,
    '只有原版的集照旧保留；同集同版本的多条（09 的 720P/1080P）不被误删',
  )
  check(
    deduped.some((i) => i.title.includes('01-12')) && deduped[0].title.includes('07v2'),
    '合集不参与取舍；过滤不改变原顺序',
  )
  check(
    dedupeLatestRevisions([{ title: '[A] 番名 - 03v3 [1080P]', revision: 3 }, { title: '[A] 番名 - 03v2 [1080P]', revision: 2 }]).length === 1,
    'v3 与 v2 同集时只留 v3',
  )

  const listSource = readFileSync(new URL('../src/components/detail/ReleaseList.vue', import.meta.url), 'utf8')
  const barSourceAgain = readFileSync(new URL('../src/components/detail/SubgroupBar.vue', import.meta.url), 'utf8')
  const aiSlotSource = readFileSync(new URL('../src/components/detail/AiSlot.vue', import.meta.url), 'utf8')
  // panelSource（面板模板）与 baseCss 上面几节已读过，这里直接用

  check(listSource.includes('class="ep"'), '资源条目左侧有集数徽标')
  check(
    /\.item\s*\{[^}]*grid-template-columns:\s*56px/s.test(listSource) &&
      /\.ep\s*\{[^}]*font-size:\s*1\.55rem/s.test(listSource) &&
      /\.ep\s*\{[^}]*font-style:\s*italic/s.test(listSource),
    '集数区照旧版：56px 竖条 + 1.55rem 斜体衬线数字（一眼扫到第几集）',
  )
  check(
    /\.ep\.batch\s*\{[^}]*font-size:\s*0\.95rem/s.test(listSource),
    '合集是范围（01-12），字号单独降一档避免撑破竖条',
  )
  check(
    /\.ep\.unknown/.test(listSource) && /item\.episode \|\| '—'/.test(listSource),
    '集数未知显示「—」（保留列宽，列表不会左右跳）',
  )
  /* 集数**交给 AI 逐条解析**，前端规则只兜底 —— 文件名写法补不完 */
  check(
    listSource.includes('props.episodes') && /const epOf =/.test(listSource) && /epOf\(item\)/.test(listSource),
    '资源列表的集号优先用 AI 解析结果（episodes prop），规则只兜底',
  )
  check(
    /const PAGE_SIZE = 120/.test(listSource) &&
      /const AI_BATCH = 120/.test(panelSource) &&
      panelSource.includes('@more="ensureParsed"'),
    '解析批次与展示同步：一屏 120 = 一批 120（PAGE_SIZE 与 AI_BATCH 必须一致）',
  )
  check(
    /watch\(limit, \(value, oldValue\) => \{[\s\S]{0,80}?if \(value > oldValue\) emit\('more', value\)/.test(listSource) &&
      /ensureParsed\(AI_BATCH\)/.test(panelSource) &&
      /merge: !first/.test(panelSource),
    '「显示更多」→ more 事件 → 面板增量解析（首批重置、后续 merge 累加；**只在变多时**通知，重置不花钱）',
  )
  check(
    /watch\(\s*\(\) => props\.items,/.test(listSource) && !/props\.activeTags, props\.batchFilter\]/.test(listSource),
    '点标签筛选不会把「显示更多」打回 120 条（只有换字幕组才重置）',
  )
  /* 排序口径：总是按集号（新的在上）+ 同集按命中数；认不出集号的沉底 */
  check(
    /list = \[\.\.\.list\]\.sort\(/.test(listSource) &&
      /episodeNumber\(item\)/.test(listSource) &&
      /if \(!ea\) return 1/.test(listSource),
    '资源列表排序：集号大的在前、同集按命中数、认不出集号/合集沉底（不再"没筛就没序"）',
  )
  check(
    readFileSync(new URL('../src/composables/useAiTags.js', import.meta.url), 'utf8').includes('mergeTags') &&
      /merge = false/.test(readFileSync(new URL('../src/composables/useEpisodes.js', import.meta.url), 'utf8')),
    '标签与集数都支持累加合并（同名 match 取并集、all 取与；集号直接合并）',
  )
  check(
    readFileSync(new URL('../src/composables/useEpisodes.js', import.meta.url), 'utf8').includes('classifyEpisodes') &&
      readFileSync(new URL('../src/api/ai.js', import.meta.url), 'utf8').includes('/api/ai/classify/episodes'),
    '集数走 AI 的链路完整（useEpisodes → /api/ai/classify/episodes）',
  )
  check(
    /releaseHighlights\(items = \[\], aiEpisodes = \{\}\)/.test(
      readFileSync(new URL('../src/utils/episode.js', import.meta.url), 'utf8'),
    ),
    '「更新至第 N 话」也优先用 AI 的集数结果',
  )
  check(
    listSource.includes('dedupeLatestRevisions') && !listSource.includes('class="ver"'),
    '修订版只用于筛选与 PREFER，不再逐条在卡片上标 v2（那是筛选条件层面的信息）',
  )
  check(
    !listSource.includes('versionOf(') && !readFileSync(new URL('../src/utils/episode.js', import.meta.url), 'utf8').includes('versionOf'),
    '前端不再自带修订版规则（规则只有后端一份，避免两处判定漂移）',
  )
  check(
    aiSlotSource.includes('.t-version') && aiSlotSource.includes("tag.kind === 'revision'") && aiSlotSource.includes('chip-count'),
    '修订版标签单独配色（靛）+ 计数（修订版 3），说明走规则筛而不是字符串匹配',
  )
  check(/\.rel-phase-enter-active/.test(listSource), '状态切换有过渡（内容不会突然长出来把下方挤下去）')

  /* 区块对齐：每个区块都包同一个卡片，左右边界由「卡片内边距」统一决定 */
  const cardSections = panelSource.match(/<section[^>]*class="card"/g) || []
  check(cardSections.length >= 6, `面板各区块都包同款卡片 → 找到 ${cardSections.length} 处`)
  check(
    !/<section v-if="data\.bgmUrl \|\| data\.mikanUrl" class="link-row">/.test(panelSource),
    '外链行也被卡片包住（不再是裸元素，左边界与其它区块齐）',
  )
  check(/\.link-btn\s*\{[^}]*flex:\s*1/s.test(panelSource), '外链按钮等分撑满卡片宽度（右边界不留空档）')
  check(/\.block-title\s*\{[^}]*font-size/s.test(baseCss), '块标题样式统一在 base.css（各组件不再各写一份）')
  check(
    aiSlotSource.includes('class="ai-title block-title"') && !/\.ai-title\s*\{[^}]*font-size/s.test(aiSlotSource),
    'AI 位标题也走全局 .block-title（四个区块标题同一个来源，不会一个 0.78 一个 0.82）',
  )
  check(
    !/\.block-title\s*\{[^}]*font-size/.test(listSource) && !/\.block-title\s*\{[^}]*font-size/.test(barSourceAgain),
    '资源列表 / 字幕组不再重复定义标题字号（用全局那份）',
  )

  /* 筛选口径照旧版：同类型 OR、跨类型 AND —— 画出来，不让用户切 */
  check(
    listSource.includes("tag.type || 'other'") && listSource.includes('.every((group)') && listSource.includes('.some((needles)'),
    '标签筛选 = 同类型 OR（组内 some）+ 跨类型 AND（组间 every）',
  )
  check(
    aiSlotSource.includes('class="sel-bar"') &&
      aiSlotSource.includes("'prefer' : 'and'") &&
      aiSlotSource.includes('class="logic or"'),
    'AI 位把筛选逻辑画出来（AND / OR / PREFER 连接词），不需要用户切模式',
  )
  check(
    aiSlotSource.includes('class="batch-toggle"') && aiSlotSource.includes("label: '单集'") && !aiSlotSource.includes('mode-switch'),
    '资源类型三段切换（单集 / 合集 / 全部），旧的「任一 / 全部」开关已移除',
  )
  check(
    listSource.includes("batchFilter === 'batch'") && /isBatchEpisode\(epOf\(item\)\)/.test(listSource),
    '单集 / 合集切换按集号判断（AI 优先、规则兜底）',
  )
  check(/\bt-res\b/.test(aiSlotSource) && /\bt-sub\b/.test(aiSlotSource), '标签按类型着色（分辨率 / 编码 / 字幕 / 片源）')
  check(/\bt-codec\b/.test(aiSlotSource) && /\bt-source\b/.test(aiSlotSource) && /\bt-other\b/.test(aiSlotSource), '类型色用令牌，不硬编码颜色值')
  check(/\bt-other\s*\{|--tag-color:\s*var\(--text-secondary\)/.test(aiSlotSource) && !/#[0-9a-fA-F]{6}/.test(aiSlotSource), 'AI 位没有写死的十六进制颜色')
  check(
    aiSlotSource.includes('class="ai-placeholder"') && /未配置[\s\S]{0,40}设置页/.test(aiSlotSource),
    'AI 未配置态：卡内虚线块 + 指路到设置页',
  )
  check(/\.chip\s*\{[^}]*border:\s*1px solid var\(--border-strong\)/s.test(barSourceAgain), '字幕组是明确的框（较深描边 + 卡片底）')
  check(/\.chip\s*\{[^}]*min-height:\s*30px/s.test(barSourceAgain), '字幕组高度一致（换行后仍对齐）')
  check(
    /\.chip\.active\s*\{[^}]*background:\s*var\(--accent\)/s.test(barSourceAgain) &&
      !/\.chip\.active\s*\{[^}]*accent-soft/s.test(barSourceAgain),
    '字幕组选中只给一个主信号（实底 + 反白），不再叠「描边+浅底+强调字色+字重」',
  )

  /* 标签配色 / 排序 / 多选：旧版这些都写在客户端组件里，这里收成令牌与独立断言 */
  const tokensCss = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8')
  check(
    /--tag-res:[^;]+;/.test(tokensCss) && /--tag-codec:[^;]+;/.test(tokensCss) && /--tag-sub:[^;]+;/.test(tokensCss),
    '标签类型色收进 tokens（分辨率蓝 / 编码紫 / 字幕绿 / 片源橙 / 合集青 / 其它灰）',
  )
  check(!/#(3b82f6|8b5cf6|22c55e|f97316|14b8a6)/.test(aiSlotSource) && !/#(3b82f6|8b5cf6|22c55e|f97316|14b8a6)/.test(listSource), '组件里不再写死十六进制色（走令牌）')
  check(
    /\.ai-chip\.active\s*\{[^}]*background:\s*var\(--tag-color/s.test(aiSlotSource) &&
      /\.ai-chip\.active\s*\{[^}]*color:\s*var\(--text-invert\)/s.test(aiSlotSource),
    '选中的标签是「实底该类型色 + 反白字」（旧版观感：一眼看出选没选）',
  )
  check(!aiSlotSource.includes('IconSparkles'), 'AI 位去掉专属图标（与其它区块同一套标题）')
  check(
    listSource.includes('scoreOf') && /scores\.get\(b\) \|\| 0\) - \(scores\.get\(a\)/.test(listSource),
    '选中标签后按命中数排序（分数预先算一遍，不在比较函数里重复跑正则）',
  )
  check(
    listSource.includes('toggleCheck') &&
      /\.item\.checked\s*\{/.test(listSource) &&
      !listSource.includes('ck-mark') &&
      !/type="checkbox"/.test(listSource),
    '多选：点整行切换，选中只用「外框 + 集数区变蓝」表达（不重复放勾选框）',
  )
  /* 需求与偏好的唯一落点：每次被指出问题先补这里，不靠人反复重复 */
  const webConventions = readFileSync(new URL('../CONVENTIONS.md', import.meta.url), 'utf8')
  check(
    webConventions.includes('参照旧版') &&
      webConventions.includes('一个状态只用一套视觉语言') &&
      webConventions.includes('静默') &&
      webConventions.includes('RSS 分组 id'),
    '界面/交互约定记在 Web/CONVENTIONS.md（含旧版基准、不重复表达、静默、字幕组两个 id）',
  )
  check(
    listSource.includes('downloadReady') && listSource.includes('DOWNLOAD_HINT') && listSource.includes('下载选中'),
    '下载按钮已预留（功能未接入 → 禁用 + 说明，位置与层级先定下来）',
  )
  check(
    listSource.includes('class="op"') && listSource.includes('IconMagnet') && listSource.includes('IconFileDownload') && listSource.includes('磁力'),
    '磁力 / 种子 / 下载 是带文字的按钮（不用 hover 猜是什么）',
  )
  check(
    /\.ops\s*\{[^}]*grid-auto-flow:\s*column/s.test(listSource) && /grid-auto-columns:\s*1fr/.test(listSource),
    '操作条三等分铺满整行（按钮数不定时自动等分，不留右侧空白）',
  )
  check(
    /\.meta\s*>\s*\*\s*\+\s*\*\s*::before/s.test(listSource) && /content:\s*'·'/s.test(listSource),
    '元信息用 `·` 分隔（465.5 MB · 09-12 00:30，靠 CSS 加在相邻项之间）',
  )
  check(
    /\.head\s*\{[^}]*flex-direction:\s*column/s.test(listSource) &&
      /\.head-info\s*\{[^}]*flex-wrap:\s*wrap/s.test(listSource) &&
      /\.head-actions\s*\{[^}]*flex-wrap:\s*wrap/s.test(listSource),
    '头部固定两行（信息 / 操作）：选中后多一个计数与按钮也不会把布局挤乱',
  )
  /* 全选：一个按钮切换；范围是当前筛选结果（含还没渲染的） */
  check(
    listSource.includes('class="select-all"') &&
      listSource.includes('toggleAll') &&
      listSource.includes('allChecked') &&
      /checked\.value = allChecked\.value \? \[\] : filtered\.value\.map/.test(listSource),
    '全选 = 一个按钮切换「全选 ↔ 取消全选」，范围是当前筛选结果',
  )
  check(
    /watch\(activeNav, \(\) => closeAnime\(\)\)/.test(appSource),
    '切到别的页面时自动收起详情面板（面板是首页卡片的延伸，回来数据还在）',
  )

  /* 评分：前后端各写一套格式化是最容易分叉的地方，统一用后端的 scoreText */
  const cardSource = readFileSync(new URL('../src/components/common/PosterCard.vue', import.meta.url), 'utf8')
  check(/\{ scoreText \|\| score \}/.test(cardSource) && /scoreText: \{ type: String/.test(cardSource), '海报卡优先显示后端的评分成品字符串（前端不做补零）')
  check(!/toFixed\(1\)/.test(cardSource) && !/toFixed\(1\)/.test(panelSource), '前端没有自己补小数位（评分口径只在后端一处）')

  /* ── ⑦ 页面首帧渲染（SSR 兜底）──────────────────────────────────────
   * 这一节是踩过坑才加的：数据还没到时模板去读 data.xxx → 渲染函数抛错 → **整页白屏**，
   * 而组件「写得对」的测试（composable 行为）完全发现不了。所以每个页面都要能空手渲染一次。 */
  const { default: SettingsPage } = await vite.ssrLoadModule('/src/pages/SettingsPage.vue')
  const { default: DiscoverPage } = await vite.ssrLoadModule('/src/pages/DiscoverPage.vue')

  for (const [name, Component] of [
    ['设置页', SettingsPage],
    ['发现页', DiscoverPage],
  ]) {
    let html = ''
    let ssrError = null
    try {
      html = await renderToString(createSSRApp({ render: () => h(Component) }))
    } catch (err) {
      ssrError = err.message
    }
    check(!ssrError, `${name}首帧能渲染（没有数据也不崩）→ ${ssrError || 'ok'}`)
    check(html.length > 0, `${name}渲染出了内容（${html.length} 字符）`)
  }
  check(
    (await renderToString(createSSRApp({ render: () => h(SettingsPage) }))).includes('加载配置'),
    '设置页首帧显示加载态（而不是空白）',
  )

  console.log(failed ? `\n✗ 失败 ${failed} 项` : '\n✓ 全部通过')
  process.exitCode = failed ? 1 : 0
} catch (err) {
  console.error('\n✗ 验收中断：', err.message)
  process.exitCode = 1
} finally {
  await vite?.close()
  api?.kill()
  // 等子进程真的退出再删临时库（Windows 上文件被占用会删不掉）
  await Promise.race([once(api, 'exit'), new Promise((r) => setTimeout(r, 3000))])
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(resolve('..', 'Server', `${DB_FILE}${suffix}`), { force: true })
  }
}
